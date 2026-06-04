#!/usr/bin/env node
/**
 * SINGLE CAMPAIGN MIGRATION — MongoDB campaigns → SQL Server v3 Campaign table
 *
 * 1. Reads one campaign from Mongo by MONGO_CAMPAIGN_ID_TO_MIGRATE (config below)
 * 2. Maps fields per Campaign_Schema_Mapping_Report.md
 * 3. Inserts one row into Campaign
 * 4. Sets Campaign.OrderNumber (GenerateOrderNumber from new ID + CreatedDate)
 * 5. Resolves sales rep: Mongo admins (campaign.salesrep) → SQL Users by email, or creates User
 * 6. Resolves customer: SQL CustomerLogins by email, or creates CustomerAccount + CustomerLogins from Mongo
 * 7. Inserts CustomerCampaigns link when customer is resolved
 *
 * Configure: edit the CONFIG section at the top of this file
 * Dry run:  set DRY_RUN = true  OR  npm run migrate:single-campaign-to-sql-v3:dry-run
 *
 * Run: npm run migrate:single-campaign-to-sql-v3
 *      npm run migrate:single-campaign-to-sql-v3:dry-run
 *
 * Bulk CSV migration: migrate-campaigns-bulk-from-csv.js (imports migrateOneCampaign from this file).
 *
 * ASSUMPTIONS (read before changing logic):
 * - One Mongo campaign _id per run (MONGO_CAMPAIGN_ID_TO_MIGRATE). No duplicate check in SQL.
 * - Mongo: campaigns in mongo-config.byCustomerCollection; customers in mongo-config.collectionName.
 * - SQL table names match SSMS exactly (Campaign, STATUSES, CustomerAccount, CustomerLogins, CustomerCampaigns).
 * - StatusID is never hardcoded — loaded from STATUSES where StatusGroup = 'Campaign'.
 * - SalesRep: campaign.salesrep ObjectId → Mongo admins collection → SQL Users by email (create if missing).
 * - Customer match is by email only (login_email first). Same email = reuse existing CustomerLogins row.
 * - If no CustomerLogins row and CREATE_CUSTOMER_IF_MISSING: create account + login BEFORE campaign insert.
 * - OrderNumber is NOT on initial INSERT — set via UPDATE after we have Campaign.ID (Terraboost API rule).
 * - Re-running the same Mongo campaign creates another Campaign row (no upsert).
 * - Dry run: preview only; customer create also skipped when dryRun (except existing-login lookup).
 *
 * DEDUPLICATION (never create a second row when one already exists):
 * - Users (sales rep):     SELECT by Email first → reuse Users.ID; INSERT only if no row.
 * - CustomerLogins:        SELECT by Email first → reuse ID + CustomerID; INSERT only if no row.
 * - CustomerAccount:       only created together with new CustomerLogins (not if login exists).
 * - CustomerCampaigns:     SELECT by (CampaignID, CustomerLoginID) before INSERT link.
 * - Campaign:              always INSERT (no upsert); re-run = duplicate campaign row by design.
 */
import path from "path";
import { fileURLToPath } from "url";
import mongodb from "mongodb";
import { getMongoConfig } from "./mongo-config.js";
import { connectSql, sql } from "./sql-connection.js";

// =============================================================================
// CONFIG — edit these values before running (all behavior flows from here)
// =============================================================================

/** Mongo campaign _id (24-char hex) to migrate into SQL v3 */
const MONGO_CAMPAIGN_ID_TO_MIGRATE = "5570c2ca7257f90b0028a525";

/** Set true to print mapped row only (no SQL insert) */
const DRY_RUN = false;

// -----------------------------------------------------------------------------
// SQL Server v3 connection
// -----------------------------------------------------------------------------
const SQL_V3_CONNECTION_STRING =
  "Server=20.118.225.243,1433;Database=TB-V1Migrate;User Id=TBProdDBO;Password=TerraB00st2025DBO!;Encrypt=True;TrustServerCertificate=True;MultipleActiveResultSets=True;Connection Timeout=30;";

const SQL_CAMPAIGN_TABLE = "Campaign";

// =============================================================================
// SQL COLUMNS REFERENCE — must match your SSMS table structure
// =============================================================================
//
// STATUSES (read — find StatusID for Campaign insert)
//   READ:  ID, StatusName, StatusGroup, DisplayOrder, Active
//   WHERE: StatusGroup = 'Campaign', Active = 1
//   MATCH: Mongo campaign_status → StatusName (e.g. "completed" → "Campaign Completed")
//
// CustomerLogins (read — find existing login by email)
//   READ:  ID, CustomerID, Email, UserName, MainContact
//   WHERE: LOWER(Email) = mongo customer login_email
//
// CustomerAccount (write — only when no CustomerLogins row exists)
//   REQUIRED (NOT NULL): CompanyName, TestCustomer, CreatedDate
//   OPTIONAL mapped from Mongo: Address1, Address2, City, State, Zip, Phone, Website,
//                              LastUpdated, CRMCompanyID, LegacyID
//
// CustomerLogins (write — only when created with new CustomerAccount)
//   REQUIRED (NOT NULL): EnablePaymentEmails
//   MAPPED from Mongo: CustomerID, Email, UserName, FirstName, LastName, MainContact,
//                      CreatedDate, LastUpdated, StripeCustomerID, CRMContactID, StatusID
//
// Campaign (write — new campaign row)
//   WRITE (INSERT): Name, StatusID, SignedDate, CreatedDate, LastUpdated, CreatedUserID,
//          CampaignDuration, Evergreen, BonusMonths, GenericArtwork, SalesRep,
//          EstimatedStartDate, EstimatedEndDate, EvergreenCancelDate, CRMDealID,
//          TimeSensative, ArtApprovalDate
//   OUT:   ID (identity, returned as InsertedCampaignId)
//   WRITE (UPDATE right after INSERT): OrderNumber — generated from ID + CreatedDate
//          (same logic as CampaignService.GenerateOrderNumber in Terraboost API)
//
// CustomerCampaigns (write — link campaign to customer)
//   WRITE: CampaignID, CustomerLoginID, CustomerID, CreatedDate
//
// Users (read/write — Campaign.SalesRep FK)
//   READ:  ID, Email, FirstName, LastName, Active
//   WHERE: LOWER(Email) = mongo admins.email (or old_email)
//   WRITE: FirstName, LastName, Email, Phone, Active, IsSupervisor, CreatedDate, LastUpdated
//   MAPPED from Mongo admins: email, full_name, created, retired (Active = !retired)
//   NOT copied: Mongo password hash (SQL Password left NULL)
//
// Mongo admins (read — campaign.salesrep ObjectId)
//   Fields: email, full_name, created, retired, old_email, authorized
//
// =============================================================================

// -----------------------------------------------------------------------------
// SQL STATUSES table — Campaign.StatusID lookup (loaded from DB, not hardcoded)
// Columns: ID, StatusName, StatusGroup, DisplayOrder, Active
// Example: Mongo "completed" → SQL StatusName "Campaign Completed" (ID 11)
// -----------------------------------------------------------------------------
const SQL_STATUS_TABLE = "STATUSES";

/** Only rows where StatusGroup = "Campaign" (not Billing / Payment) */
const SQL_STATUS_GROUP_FOR_CAMPAIGN = "Campaign";

// -----------------------------------------------------------------------------
// SQL CustomerLogins — lookup customer by Email (matches your SSMS table)
// Columns used: ID, CustomerID, Email, MainContact
// -----------------------------------------------------------------------------
const SQL_CUSTOMER_LOGIN_TABLE = "CustomerLogins";

/** SQL company table — parent of CustomerLogins.CustomerID */
const SQL_CUSTOMER_ACCOUNT_TABLE = "CustomerAccount";

/**
 * When true: if CustomerLogins already exists for email → reuse it (no INSERT).
 * When false and no login: skip customer link.
 * When true and no login: INSERT CustomerAccount + CustomerLogins once.
 */
const CREATE_CUSTOMER_IF_MISSING = true;

/** Mongo customers — primary email: login_email */
const MONGO_CUSTOMER_EMAIL_FIELDS = ["login_email", "email", "customer_contact_email"];

/**
 * Mongo field names tried per SQL column (first match wins).
 * Add your real Mongo keys here if they differ.
 */
const MONGO_CUSTOMER_FIELD_CANDIDATES = {
  companyName: [
    "company_name",
    "customer_company",
    "company",
    "business_name",
    "customer_business_name",
  ],
  firstName: ["customer_first_name", "first_name", "firstname", "contact_first_name"],
  lastName: ["customer_last_name", "last_name", "lastname", "contact_last_name"],
  fullName: ["customer_name", "name", "contact_name"],
  address1: ["address", "address1", "customer_address", "street"],
  address2: ["address2", "customer_address2"],
  city: ["city", "customer_city"],
  state: ["state", "customer_state"],
  zip: ["zip", "zipcode", "postal_code", "customer_zip"],
  phone: ["phone", "customer_phone", "contact_phone"],
  website: ["website", "customer_website", "url"],
  stripeCustomerId: ["stripe_customer_id", "stripe_id"],
  salesforceAccountId: ["salesforce_account_id", "sf_account_id"],
  salesforceContactId: ["salesforce_contact_id", "sf_contact_id"],
  legacyId: ["legacy_id", "legacy_user_id", "sql_legacy_id"],
  created: ["created", "created_at"],
  updated: ["updated", "updated_at"],
};

// -----------------------------------------------------------------------------
// SQL CustomerCampaigns — link table (matches your SSMS table)
// Columns inserted: CampaignID, CustomerLoginID, CustomerID, CreatedDate
// -----------------------------------------------------------------------------
const SQL_CUSTOMER_CAMPAIGN_TABLE = "CustomerCampaigns";

/** Insert row into CustomerCampaigns after Campaign insert */
const INSERT_CUSTOMER_CAMPAIGN_LINK = true;

// -----------------------------------------------------------------------------
// Sales rep — Mongo admins → SQL Users → Campaign.SalesRep
// campaign.salesrep is ObjectId pointing at admins collection (not customers)
// -----------------------------------------------------------------------------
const MONGO_ADMINS_COLLECTION = "admins";

const SQL_USERS_TABLE = "Users";

/**
 * When true: if Users already exists for admin email → reuse Users.ID (no INSERT).
 * When false and no user: SalesRep stays NULL.
 * When true and no user: INSERT Users once from Mongo admins.
 */
const CREATE_SALES_REP_USER_IF_MISSING = true;

/** Optional override: Mongo admins _id hex → SQL Users.ID (skips lookup/create) */
const MONGO_SALESREP_TO_SQL_USER_ID = {
  // "55786a2e8420f80b00b6b561": 123,
};

/** admins.email fields tried in order */
const MONGO_ADMIN_EMAIL_FIELDS = ["email", "old_email"];

// -----------------------------------------------------------------------------
// Defaults when Mongo has no value (used instead of failing the migration)
// -----------------------------------------------------------------------------
const DEFAULT_CAMPAIGN_NAME_PREFIX = "Migrated";
const DEFAULT_CREATED_USER_ID = null;
const DEFAULT_GENERIC_ARTWORK = false;
const DEFAULT_TIME_SENSITIVE = false;

/** CustomerAccount.CompanyName when Mongo has no company field (max 100 chars) */
const DEFAULT_CUSTOMER_COMPANY_PREFIX = "Migrated";

/** CustomerAccount.TestCustomer — NOT NULL bit */
const DEFAULT_TEST_CUSTOMER = false;

/** CustomerLogins.EnablePaymentEmails — NOT NULL bit for legacy migrated users */
const DEFAULT_ENABLE_PAYMENT_EMAILS = false;

/** CustomerLogins.MainContact when we create the first login for an account */
const DEFAULT_MAIN_CONTACT = true;

/** Users.IsSupervisor when creating from Mongo admins (sales reps are not supervisors by default) */
const DEFAULT_USER_IS_SUPERVISOR = false;

// =============================================================================
// HELPERS — dates, IDs, strings (no database I/O)
// =============================================================================

const { MongoClient, ObjectId } = mongodb;

/** True if CLI passed e.g. --dry-run */
function getCliFlag(argv, flag) {
  return argv.includes(flag);
}

/** Mongo ObjectId or string → 24-char hex (empty if missing). */
function normalizeObjectIdHex(value) {
  if (!value) return "";
  if (typeof value.toHexString === "function") return value.toHexString();
  return String(value);
}

/** ISO string / Date → JS Date or null if invalid. */
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date → YYYY-MM-DD for SQL date columns. */
function toDateOnly(value) {
  const d = toDate(value);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** EstimatedEndDate assumption: start date + campaign_duration months (calendar months, UTC). */
function addMonths(dateOnly, months) {
  if (!dateOnly || months == null) return null;
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + Number(months));
  return d.toISOString().slice(0, 10);
}

/**
 * SQL Campaign.Name = customers.customer_name + " - " + customers.customer_category only.
 * Never uses searchable_text, login_email, stripe_customer_id, or campaign blobs.
 */
function buildCampaignName(mongoCustomerDoc, mongoCampaignIdHex) {
  const nameRaw = mongoCustomerDoc?.customer_name;
  const categoryRaw = mongoCustomerDoc?.customer_category;

  const name =
    nameRaw != null && String(nameRaw).trim() !== ""
      ? String(nameRaw).trim().slice(0, 150)
      : null;
  const category =
    categoryRaw != null && String(categoryRaw).trim() !== ""
      ? String(categoryRaw).trim().slice(0, 80)
      : null;

  if (name && category) {
    return `${name} - ${category}`.slice(0, 200);
  }
  if (name) return name;
  if (category) return category;

  const id = mongoCampaignIdHex || "unknown";
  return `${DEFAULT_CAMPAIGN_NAME_PREFIX}-${id}`.slice(0, 200);
}

/** Normalize status text for matching (lowercase, no spaces/underscores/dashes). */
function normalizeStatusKey(value) {
  return String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
}

// =============================================================================
// STATUS LOOKUP — Mongo campaign_status → SQL Campaign.StatusID
// Assumption: short Mongo values (e.g. "completed") match long SQL names ("Campaign Completed")
// =============================================================================

/**
 * Step 1: Load ALL campaign statuses from SQL STATUSES table (no hardcoded IDs).
 * Returns every active row where StatusGroup = Campaign.
 */
async function fetchAllCampaignStatusesFromSql(pool) {
  const request = pool.request();
  request.input("statusGroup", sql.NVarChar(50), SQL_STATUS_GROUP_FOR_CAMPAIGN);

  // STATUSES columns: ID, StatusName, StatusGroup, DisplayOrder, Active
  const result = await request.query(`
    SELECT ID, StatusName, StatusGroup, DisplayOrder, Active
    FROM ${SQL_STATUS_TABLE}
    WHERE LOWER(LTRIM(RTRIM(StatusGroup))) = LOWER(LTRIM(RTRIM(@statusGroup)))
      AND Active = 1
    ORDER BY DisplayOrder, ID
  `);

  return result.recordset;
}

/**
 * Step 2: Build lookup maps from STATUSES rows (StatusName → ID).
 */
function buildCampaignStatusLookupMap(statusRows) {
  const byExactLower = new Map();
  const byNormalized = new Map();

  for (const row of statusRows) {
    const entry = { statusId: row.ID, statusName: row.StatusName };
    const exactKey = String(row.StatusName).trim().toLowerCase();
    const normKey = normalizeStatusKey(row.StatusName);

    if (!byExactLower.has(exactKey)) {
      byExactLower.set(exactKey, entry);
    }
    if (!byNormalized.has(normKey)) {
      byNormalized.set(normKey, entry);
    }
  }

  return { byExactLower, byNormalized, all: statusRows };
}

/**
 * When Mongo uses short status (e.g. "completed") and SQL uses long name
 * (e.g. "Campaign Completed"), pick the best Campaign status row.
 */
function findStatusByContainsMongoWord(mongoCampaignStatus, statusRows) {
  const mongoLower = String(mongoCampaignStatus).trim().toLowerCase();
  const mongoNorm = normalizeStatusKey(mongoCampaignStatus);
  if (!mongoLower) return null;

  const matches = statusRows.filter((row) => {
    const nameLower = String(row.StatusName).toLowerCase();
    const nameNorm = normalizeStatusKey(row.StatusName);
    return (
      nameLower.includes(mongoLower) ||
      nameNorm.endsWith(mongoNorm) ||
      nameNorm.includes(mongoNorm)
    );
  });

  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];

  const endsWith = matches.find((row) => {
    const nameLower = String(row.StatusName).toLowerCase();
    return nameLower.endsWith(mongoLower) || nameLower.endsWith(` ${mongoLower}`);
  });
  if (endsWith) return endsWith;

  return matches.sort(
    (a, b) => String(a.StatusName).length - String(b.StatusName).length
  )[0];
}

/**
 * Step 3: Map Mongo campaign_status → SQL STATUSES.ID (Campaign group only).
 * Tries: exact name → normalized → StatusName contains mongo word
 */
function mapMongoCampaignStatusToSqlStatusId(mongoCampaignStatus, statusLookup) {
  if (!mongoCampaignStatus) {
    return { statusId: null, statusName: null, matchType: null };
  }

  const exactKey = String(mongoCampaignStatus).trim().toLowerCase();
  const normKey = normalizeStatusKey(mongoCampaignStatus);

  if (statusLookup.byExactLower.has(exactKey)) {
    const match = statusLookup.byExactLower.get(exactKey);
    return {
      statusId: match.statusId,
      statusName: match.statusName,
      matchType: "exact StatusName (case-insensitive)",
    };
  }

  if (statusLookup.byNormalized.has(normKey)) {
    const match = statusLookup.byNormalized.get(normKey);
    return {
      statusId: match.statusId,
      statusName: match.statusName,
      matchType: "normalized StatusName",
    };
  }

  const containsRow = findStatusByContainsMongoWord(
    mongoCampaignStatus,
    statusLookup.all
  );
  if (containsRow) {
    return {
      statusId: containsRow.ID,
      statusName: containsRow.StatusName,
      matchType: `StatusName contains "${mongoCampaignStatus}"`,
    };
  }

  return {
    statusId: null,
    statusName: null,
    matchType: null,
    availableStatuses: statusLookup.all,
  };
}

// =============================================================================
// SALES REP — Mongo admins → SQL Users → Campaign.SalesRep
// =============================================================================

/** Parse admins.full_name e.g. "Joe Barros - Retired" → first/last (drops " - Retired" suffix). */
function parseAdminFullName(fullName) {
  const cleaned = String(fullName || "")
    .replace(/\s*-\s*Retired\s*$/i, "")
    .trim();
  return splitFullName(cleaned);
}

/** Email from Mongo admins document. */
function resolveMongoAdminEmail(doc) {
  if (!doc) return { email: null, emailField: null };
  for (const field of MONGO_ADMIN_EMAIL_FIELDS) {
    const email = normalizeEmail(doc[field]);
    if (email) return { email, emailField: field };
  }
  return { email: null, emailField: null };
}

/** Load one sales rep from Mongo admins by campaign.salesrep ObjectId. */
async function fetchMongoAdminById(adminObjectIdHex) {
  if (!adminObjectIdHex) {
    return { mongoAdminId: "", doc: null, email: null, emailField: null };
  }

  const config = getMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.dbName)
      .collection(MONGO_ADMINS_COLLECTION)
      .findOne({ _id: new ObjectId(adminObjectIdHex) });

    if (!doc) {
      return { mongoAdminId: adminObjectIdHex, doc: null, email: null, emailField: null };
    }

    const { email, emailField } = resolveMongoAdminEmail(doc);
    return { mongoAdminId: adminObjectIdHex, doc, email, emailField };
  } finally {
    await client.close();
  }
}

/**
 * Map Mongo admins → SQL Users INSERT row.
 * Assumption: all Users columns except ID are nullable; Password not copied from Mongo.
 */
function mapMongoAdminToSqlUser(mongoDoc, email) {
  const { firstName, lastName } = parseAdminFullName(mongoDoc?.full_name);
  const created = toDate(mongoDoc?.created) || new Date();
  const retired = mongoDoc?.retired === true;
  const authorized = mongoDoc?.authorized !== false;

  return {
    FirstName: truncate(firstName, 50),
    LastName: truncate(lastName, 50),
    Email: truncate(email, 255),
    Phone: null,
    Password: null,
    SupervisorID: null,
    IsSupervisor: DEFAULT_USER_IS_SUPERVISOR ? 1 : 0,
    Active: retired || !authorized ? 0 : 1,
    CreatedDate: created,
    LastUpdated: toDate(mongoDoc?.retired_date) || created,
    CreatedUserID: DEFAULT_CREATED_USER_ID,
    LastUpdatedUserID: null,
  };
}

/**
 * Find SQL Users row by email (case-insensitive). Prefers Active = 1.
 * Used before any Users INSERT — if this returns a row, we do NOT create another user.
 */
async function findSqlUserByEmail(pool, email) {
  const emailLower = normalizeEmail(email);
  if (!emailLower) return null;

  const request = pool.request();
  request.input("emailLower", sql.NVarChar(255), emailLower);

  const result = await request.query(`
    SELECT TOP 1
      ID AS UserId,
      Email,
      FirstName,
      LastName,
      Active
    FROM ${SQL_USERS_TABLE}
    WHERE LOWER(LTRIM(RTRIM(Email))) = @emailLower
    ORDER BY CASE WHEN Active = 1 THEN 0 ELSE 1 END, ID
  `);

  if (!result.recordset.length) return null;

  const row = result.recordset[0];
  return {
    userId: row.UserId,
    email: row.Email,
    firstName: row.FirstName,
    lastName: row.LastName,
    active: row.Active,
  };
}

/** INSERT Users — mapped columns from Mongo admins; Password left NULL. */
async function insertSqlUserRow(pool, table, row) {
  const request = pool.request();
  request.input("firstName", sql.VarChar(50), row.FirstName);
  request.input("lastName", sql.VarChar(50), row.LastName);
  request.input("email", sql.VarChar(255), row.Email);
  request.input("password", sql.VarChar(60), row.Password);
  request.input("phone", sql.VarChar(11), row.Phone);
  request.input("supervisorId", sql.Int, row.SupervisorID);
  request.input("isSupervisor", sql.Bit, row.IsSupervisor);
  request.input("active", sql.Bit, row.Active);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("createdUserId", sql.Int, row.CreatedUserID);
  request.input("lastUpdated", sql.DateTime, row.LastUpdated);
  request.input("lastUpdatedUserId", sql.Int, row.LastUpdatedUserID);

  const result = await request.query(`
    INSERT INTO ${table} (
      FirstName, LastName, Email, Password, Phone, SupervisorID,
      IsSupervisor, Active, CreatedDate, CreatedUserID, LastUpdated, LastUpdatedUserID
    )
    OUTPUT INSERTED.ID AS InsertedUserId
    VALUES (
      @firstName, @lastName, @email, @password, @phone, @supervisorId,
      @isSupervisor, @active, @createdDate, @createdUserId, @lastUpdated, @lastUpdatedUserId
    );
  `);

  return result.recordset[0].InsertedUserId;
}

/**
 * Resolve Campaign.SalesRep (SQL Users.ID):
 *   0) Optional MONGO_SALESREP_TO_SQL_USER_ID override
 *   1) Load Mongo admins by campaign.salesrep ObjectId
 *   2) Find Users by admins email
 *   3) If missing and CREATE_SALES_REP_USER_IF_MISSING: INSERT Users
 */
async function resolveSalesRepForCampaign(pool, mongoSalesRepObjectId, options = {}) {
  const dryRun = options.dryRun === true;
  const mongoAdminHex = normalizeObjectIdHex(mongoSalesRepObjectId);

  const base = {
    mongoAdminHex,
    mongoAdminEmail: null,
    mongoAdminEmailField: null,
    mongoAdminFullName: null,
    salesRepUserId: null,
    sqlUserEmail: null,
    matchType: null,
    skipReason: null,
    userCreated: false,
    insertedUserId: null,
    userPreview: null,
  };

  if (!mongoAdminHex) {
    return { ...base, skipReason: "Campaign has no salesrep field" };
  }

  if (MONGO_SALESREP_TO_SQL_USER_ID[mongoAdminHex] != null) {
    const userId = MONGO_SALESREP_TO_SQL_USER_ID[mongoAdminHex];
    return {
      ...base,
      salesRepUserId: userId,
      matchType: "MONGO_SALESREP_TO_SQL_USER_ID override",
    };
  }

  const mongoAdmin = await fetchMongoAdminById(mongoAdminHex);
  if (!mongoAdmin.doc) {
    return {
      ...base,
      skipReason: `Mongo admin not found in ${MONGO_ADMINS_COLLECTION}: ${mongoAdminHex}`,
    };
  }

  base.mongoAdminEmail = mongoAdmin.email;
  base.mongoAdminEmailField = mongoAdmin.emailField;
  base.mongoAdminFullName = mongoAdmin.doc.full_name ?? null;

  if (!mongoAdmin.email) {
    return {
      ...base,
      skipReason: `No email on Mongo admin ${mongoAdminHex} (checked: ${MONGO_ADMIN_EMAIL_FIELDS.join(", ")})`,
    };
  }

  // Existing user by email → reuse; do NOT insert duplicate Users row
  const sqlUser = await findSqlUserByEmail(pool, mongoAdmin.email);
  if (sqlUser) {
    return {
      ...base,
      salesRepUserId: sqlUser.userId,
      sqlUserEmail: sqlUser.email,
      matchType: `${SQL_USERS_TABLE}.Email (existing — no insert)`,
    };
  }

  if (!CREATE_SALES_REP_USER_IF_MISSING) {
    return {
      ...base,
      skipReason: `No SQL Users row with Email="${mongoAdmin.email}" (CREATE_SALES_REP_USER_IF_MISSING is false)`,
    };
  }

  const userRow = mapMongoAdminToSqlUser(mongoAdmin.doc, mongoAdmin.email);

  if (dryRun) {
    return {
      ...base,
      matchType: "dry-run: would INSERT Users (sales rep)",
      userPreview: userRow,
    };
  }

  const insertedUserId = await insertSqlUserRow(pool, SQL_USERS_TABLE, userRow);
  return {
    ...base,
    userCreated: true,
    insertedUserId,
    salesRepUserId: insertedUserId,
    sqlUserEmail: userRow.Email,
    matchType: `INSERT ${SQL_USERS_TABLE} (from Mongo ${MONGO_ADMINS_COLLECTION})`,
    userPreview: userRow,
  };
}

// =============================================================================
// CUSTOMER — Mongo customers doc → SQL CustomerAccount / CustomerLogins
// Assumption: campaign.customer is ObjectId ref; email drives SQL match
// =============================================================================

function normalizeEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  return email.includes("@") ? email : null;
}

/** Trim string and cap length for SQL varchar columns. */
function truncate(value, maxLen) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/** Return first non-empty value from Mongo doc using a list of possible field names. */
function pickFirstMongoField(doc, fieldNames) {
  if (!doc) return null;
  for (const name of fieldNames) {
    const v = doc[name];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/** Split "First Last" into { firstName, lastName }. */
function splitFullName(fullName) {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** Extract email + which Mongo field it came from. */
function resolveMongoCustomerEmail(doc) {
  if (!doc) return { email: null, emailField: null };
  for (const field of MONGO_CUSTOMER_EMAIL_FIELDS) {
    const email = normalizeEmail(doc[field]);
    if (email) return { email, emailField: field };
  }
  return { email: null, emailField: null };
}

/**
 * Load full Mongo customers document for campaign.customer ObjectId.
 * Used to map CustomerAccount + CustomerLogins when SQL has no row yet.
 */
async function fetchMongoCustomerById(customerObjectIdHex) {
  if (!customerObjectIdHex) {
    return { mongoCustomerId: "", doc: null, email: null, emailField: null };
  }

  const config = getMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.dbName)
      .collection(config.collectionName)
      .findOne({ _id: new ObjectId(customerObjectIdHex) });

    if (!doc) {
      return { mongoCustomerId: customerObjectIdHex, doc: null, email: null, emailField: null };
    }

    const { email, emailField } = resolveMongoCustomerEmail(doc);
    return { mongoCustomerId: customerObjectIdHex, doc, email, emailField };
  } finally {
    await client.close();
  }
}

/**
 * Map Mongo customer → SQL CustomerAccount row.
 * NOT NULL in SQL: CompanyName, TestCustomer, CreatedDate — always set.
 * Other columns inserted only when Mongo has a value.
 */
function mapMongoCustomerToCustomerAccount(mongoDoc, mongoCustomerHex, email) {
  const companyRaw = pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.companyName);
  // CompanyName is NOT NULL — fallback chain if Mongo has no company field
  const companyName =
    truncate(companyRaw, 100) ||
    truncate(`${DEFAULT_CUSTOMER_COMPANY_PREFIX}-${mongoCustomerHex.slice(-8)}`, 100) ||
    truncate(email?.split("@")[0] || DEFAULT_CUSTOMER_COMPANY_PREFIX, 100);

  const created = toDate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.created)) || new Date();
  const updated = toDate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.updated));

  const sfAccount = pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.salesforceAccountId);
  const crmCompanyId = sfAccount ? parseCrmDealId(sfAccount) : null;

  const legacyRaw = pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.legacyId);
  const legacyId = legacyRaw != null && Number.isFinite(Number(legacyRaw)) ? Number(legacyRaw) : null;

  return {
    CompanyName: companyName,
    TestCustomer: DEFAULT_TEST_CUSTOMER ? 1 : 0,
    CreatedDate: created,
    LastUpdated: updated,
    Address1: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.address1), 255),
    Address2: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.address2), 255),
    City: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.city), 100),
    State: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.state), 2),
    Zip: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.zip), 10),
    Phone: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.phone), 11),
    Website: truncate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.website), 255),
    CRMCompanyID: crmCompanyId,
    LegacyID: legacyId,
  };
}

/**
 * Map Mongo customer → SQL CustomerLogins row (after CustomerAccount insert).
 * NOT NULL in SQL: EnablePaymentEmails — always set.
 * CustomerID comes from new CustomerAccount.ID; Email from Mongo login_email, etc.
 */
function mapMongoCustomerToCustomerLogin(mongoDoc, customerAccountId, email) {
  let firstName = truncate(
    pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.firstName),
    50
  );
  let lastName = truncate(
    pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.lastName),
    50
  );

  if (!firstName && !lastName) {
    const fromFull = splitFullName(
      pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.fullName) || ""
    );
    firstName = truncate(fromFull.firstName, 50);
    lastName = truncate(fromFull.lastName, 50);
  }

  const created = toDate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.created)) || new Date();
  const updated = toDate(pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.updated));
  const sfContact = pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.salesforceContactId);

  return {
    CustomerID: customerAccountId,
    Email: truncate(email, 100),
    UserName: truncate(email, 50),
    FirstName: firstName,
    LastName: lastName,
    MainContact: DEFAULT_MAIN_CONTACT ? 1 : 0,
    EnablePaymentEmails: DEFAULT_ENABLE_PAYMENT_EMAILS ? 1 : 0,
    CreatedDate: created,
    LastUpdated: updated,
    StripeCustomerID: truncate(
      pickFirstMongoField(mongoDoc, MONGO_CUSTOMER_FIELD_CANDIDATES.stripeCustomerId),
      50
    ),
    CRMContactID: sfContact ? parseCrmDealId(sfContact) : null,
    StatusID: null, // Assumption: nullable; API uses 55 for new Cognito users — not set on migration
  };
}

/**
 * Find SQL CustomerLogin by email (case-insensitive).
 * Prefers MainContact = 1 when multiple rows share the same email.
 * Used before any CustomerAccount/CustomerLogins INSERT — if found, we do NOT create new customer rows.
 */
async function findSqlCustomerLoginByEmail(pool, email) {
  const emailLower = normalizeEmail(email);
  if (!emailLower) return null;

  const request = pool.request();
  request.input("emailLower", sql.NVarChar(100), emailLower);

  // CustomerLogins columns: ID, CustomerID, Email, UserName, MainContact
  const result = await request.query(`
    SELECT TOP 1
      ID AS CustomerLoginId,
      CustomerID,
      Email,
      UserName,
      MainContact
    FROM ${SQL_CUSTOMER_LOGIN_TABLE}
    WHERE LOWER(LTRIM(RTRIM(Email))) = @emailLower
    ORDER BY CASE WHEN MainContact = 1 THEN 0 ELSE 1 END, ID
  `);

  if (!result.recordset.length) return null;

  const row = result.recordset[0];
  return {
    customerLoginId: row.CustomerLoginId,
    customerId: row.CustomerID,
    email: row.Email,
    userName: row.UserName,
    mainContact: row.MainContact,
  };
}

/**
 * INSERT CustomerAccount — required NOT NULL columns always sent;
 * optional columns only included when mapped value is non-null.
 */
async function insertCustomerAccountRow(pool, table, row) {
  const request = pool.request();
  request.input("companyName", sql.VarChar(100), row.CompanyName);
  request.input("testCustomer", sql.Bit, row.TestCustomer);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("lastUpdated", sql.DateTime, row.LastUpdated);
  request.input("address1", sql.VarChar(255), row.Address1);
  request.input("address2", sql.VarChar(255), row.Address2);
  request.input("city", sql.VarChar(100), row.City);
  request.input("state", sql.VarChar(2), row.State);
  request.input("zip", sql.VarChar(10), row.Zip);
  request.input("phone", sql.VarChar(11), row.Phone);
  request.input("website", sql.VarChar(255), row.Website);
  request.input("crmCompanyId", sql.BigInt, row.CRMCompanyID);
  request.input("legacyId", sql.Int, row.LegacyID);

  const result = await request.query(`
    INSERT INTO ${table} (
      CompanyName, TestCustomer, CreatedDate,
      LastUpdated, Address1, Address2, City, State, Zip, Phone, Website,
      CRMCompanyID, LegacyID
    )
    OUTPUT INSERTED.ID AS InsertedCustomerAccountId
    VALUES (
      @companyName, @testCustomer, @createdDate,
      @lastUpdated, @address1, @address2, @city, @state, @zip, @phone, @website,
      @crmCompanyId, @legacyId
    );
  `);

  return result.recordset[0].InsertedCustomerAccountId;
}

/**
 * INSERT CustomerLogins — EnablePaymentEmails is NOT NULL (always set).
 * CustomerID links to CustomerAccount.ID from previous insert.
 */
async function insertCustomerLoginRow(pool, table, row) {
  const request = pool.request();
  request.input("customerId", sql.Int, row.CustomerID);
  request.input("email", sql.VarChar(100), row.Email);
  request.input("userName", sql.VarChar(50), row.UserName);
  request.input("firstName", sql.VarChar(50), row.FirstName);
  request.input("lastName", sql.VarChar(50), row.LastName);
  request.input("mainContact", sql.Bit, row.MainContact);
  request.input("enablePaymentEmails", sql.Bit, row.EnablePaymentEmails);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("lastUpdated", sql.DateTime, row.LastUpdated);
  request.input("stripeCustomerId", sql.VarChar(50), row.StripeCustomerID);
  request.input("crmContactId", sql.BigInt, row.CRMContactID);
  request.input("statusId", sql.Int, row.StatusID);

  const result = await request.query(`
    INSERT INTO ${table} (
      CustomerID, Email, UserName, FirstName, LastName, MainContact,
      EnablePaymentEmails, CreatedDate, LastUpdated, StripeCustomerID, CRMContactID, StatusID
    )
    OUTPUT INSERTED.ID AS InsertedCustomerLoginId
    VALUES (
      @customerId, @email, @userName, @firstName, @lastName, @mainContact,
      @enablePaymentEmails, @createdDate, @lastUpdated, @stripeCustomerId, @crmContactId, @statusId
    );
  `);

  return result.recordset[0].InsertedCustomerLoginId;
}

/**
 * Customer resolution for CustomerCampaigns link:
 *   A) Find existing CustomerLogins by Mongo email
 *   B) If missing and CREATE_CUSTOMER_IF_MISSING: insert CustomerAccount + CustomerLogins from Mongo
 *
 * @param {{ dryRun?: boolean }} options — dryRun=true only previews create, no SQL writes
 */
async function resolveCustomerForCampaign(pool, mongoCustomerObjectId, options = {}) {
  const dryRun = options.dryRun === true;
  const mongoCustomerHex = normalizeObjectIdHex(mongoCustomerObjectId);

  const baseLink = {
    mongoCustomerHex,
    mongoEmail: null,
    mongoEmailField: null,
    customerLoginId: null,
    customerId: null,
    sqlEmail: null,
    matchType: null,
    skipReason: null,
    customerAccountCreated: false,
    customerLoginCreated: false,
    insertedCustomerAccountId: null,
    insertedCustomerLoginId: null,
    customerAccountPreview: null,
    customerLoginPreview: null,
  };

  if (!mongoCustomerHex) {
    return { ...baseLink, skipReason: "Campaign has no customer field" };
  }

  const mongoCustomer = await fetchMongoCustomerById(mongoCustomerHex);
  if (!mongoCustomer.doc) {
    return {
      ...baseLink,
      skipReason: `Mongo customer not found: ${mongoCustomerHex}`,
    };
  }

  if (!mongoCustomer.email) {
    return {
      ...baseLink,
      skipReason: `No email on Mongo customer ${mongoCustomerHex} (checked: ${MONGO_CUSTOMER_EMAIL_FIELDS.join(", ")})`,
    };
  }

  baseLink.mongoEmail = mongoCustomer.email;
  baseLink.mongoEmailField = mongoCustomer.emailField;

  // --- Path A: existing SQL login by email → reuse; do NOT insert CustomerAccount or CustomerLogins ---
  const sqlCustomer = await findSqlCustomerLoginByEmail(pool, mongoCustomer.email);
  if (sqlCustomer) {
    return {
      ...baseLink,
      customerLoginId: sqlCustomer.customerLoginId,
      customerId: sqlCustomer.customerId,
      sqlEmail: sqlCustomer.email,
      matchType: `${SQL_CUSTOMER_LOGIN_TABLE}.Email (existing — no insert)`,
    };
  }

  // --- Path B: no login for this email — create account + login once (only if CREATE_CUSTOMER_IF_MISSING) ---
  if (!CREATE_CUSTOMER_IF_MISSING) {
    return {
      ...baseLink,
      skipReason: `No SQL CustomerLogins row with Email="${mongoCustomer.email}" (CREATE_CUSTOMER_IF_MISSING is false)`,
    };
  }

  const accountRow = mapMongoCustomerToCustomerAccount(
    mongoCustomer.doc,
    mongoCustomerHex,
    mongoCustomer.email
  );
  const loginRowPreview = mapMongoCustomerToCustomerLogin(
    mongoCustomer.doc,
    null,
    mongoCustomer.email
  );

  if (dryRun) {
    return {
      ...baseLink,
      matchType: "dry-run: would INSERT CustomerAccount + CustomerLogins",
      customerAccountPreview: accountRow,
      customerLoginPreview: { ...loginRowPreview, CustomerID: "(new CustomerAccount.ID)" },
    };
  }

  const insertedAccountId = await insertCustomerAccountRow(
    pool,
    SQL_CUSTOMER_ACCOUNT_TABLE,
    accountRow
  );
  const loginRow = mapMongoCustomerToCustomerLogin(
    mongoCustomer.doc,
    insertedAccountId,
    mongoCustomer.email
  );
  const insertedLoginId = await insertCustomerLoginRow(
    pool,
    SQL_CUSTOMER_LOGIN_TABLE,
    loginRow
  );

  return {
    ...baseLink,
    customerAccountCreated: true,
    customerLoginCreated: true,
    insertedCustomerAccountId: insertedAccountId,
    insertedCustomerLoginId: insertedLoginId,
    customerLoginId: insertedLoginId,
    customerId: insertedAccountId,
    sqlEmail: loginRow.Email,
    matchType: `INSERT ${SQL_CUSTOMER_ACCOUNT_TABLE} + ${SQL_CUSTOMER_LOGIN_TABLE} (from Mongo)`,
    customerAccountPreview: accountRow,
    customerLoginPreview: loginRow,
  };
}

// =============================================================================
// CAMPAIGN — Mongo campaigns doc → SQL Campaign row + related writes
// =============================================================================

/**
 * Salesforce / CRM strings → bigint: digits only (e.g. "00610000027" → 610000027).
 * Used for CRMDealID, CRMCompanyID, CRMContactID.
 */
function parseCrmDealId(salesforceOpportunityId) {
  if (!salesforceOpportunityId) return null;
  const digits = String(salesforceOpportunityId).replace(/\D/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Maps Mongo campaign document → SQL Campaign INSERT payload.
 * StatusID filled later in main() after STATUSES lookup.
 * customerLink.mongoCustomerHex filled here; full customer resolution in main().
 */
function mapMongoCampaignToSqlV3Row(mongoDoc, mongoCustomerDoc = null) {
  const created = toDate(mongoDoc.created);
  const updated = toDate(mongoDoc.updated);
  // SignedDate: booked date, else created (assumption: booked ≈ signed in legacy data)
  const signed = toDate(mongoDoc.campaign_booked_date) || created;
  // Start: estimated_start_date preferred; fallback campaign_start_date
  const estimatedStart =
    toDateOnly(mongoDoc.estimated_start_date) ||
    toDateOnly(mongoDoc.campaign_start_date);
  const duration = mongoDoc.campaign_duration ?? null;
  const estimatedEnd = addMonths(estimatedStart, duration);
  const mongoCampaignIdHex = normalizeObjectIdHex(mongoDoc._id);

  return {
    mongoCampaignId: mongoCampaignIdHex,
    Name: buildCampaignName(mongoCustomerDoc, mongoCampaignIdHex),
    StatusID: null, // set after SQL Status table lookup in main()
    SignedDate: signed,
    CreatedDate: created || signed || new Date(),
    LastUpdated: updated,
    CreatedUserID: DEFAULT_CREATED_USER_ID, // Assumption: no Mongo → SQL user map for creator
    CampaignDuration: duration,
    Evergreen: mongoDoc.campaign_auto_renews ? 1 : 0,
    BonusMonths: mongoDoc.campaign_bonus_month ?? null,
    GenericArtwork: DEFAULT_GENERIC_ARTWORK ? 1 : 0,
    SalesRep: null, // set in main() after Mongo admins → SQL Users lookup
    EstimatedStartDate: estimatedStart,
    EstimatedEndDate: estimatedEnd,
    EvergreenCancelDate: toDateOnly(mongoDoc.campaign_renewal_date), // Assumption: renewal date used as cancel date field
    CRMDealID: parseCrmDealId(mongoDoc.salesforce_opportunity_id),
    TimeSensative: DEFAULT_TIME_SENSITIVE ? 1 : 0, // Column spelling matches SQL typo "Sensative"
    ArtApprovalDate: mongoDoc.art_completed ? toDateOnly(updated || created) : null, // Assumption: art_completed → approval date
    customerLink: {
      mongoCustomerHex: normalizeObjectIdHex(mongoDoc.customer),
    },
  };
}

/** Load one document from Mongo campaigns collection by _id. */
async function fetchMongoCampaign(mongoCampaignIdHex) {
  const config = getMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.dbName)
      .collection(config.byCustomerCollection)
      .findOne({ _id: new ObjectId(mongoCampaignIdHex) });
    return doc;
  } finally {
    await client.close();
  }
}

/**
 * INSERT Campaign — does NOT set OrderNumber (identity ID unknown until after INSERT).
 * See updateCampaignOrderNumber() immediately after this in main().
 */
async function insertCampaignRow(pool, table, row) {
  const request = pool.request();
  request.input("name", sql.NVarChar(255), row.Name);
  request.input("statusId", sql.Int, row.StatusID);
  request.input("signedDate", sql.DateTime, row.SignedDate);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("lastUpdated", sql.DateTime, row.LastUpdated);
  request.input("createdUserId", sql.Int, row.CreatedUserID);
  request.input("campaignDuration", sql.Int, row.CampaignDuration);
  request.input("evergreen", sql.Bit, row.Evergreen);
  request.input("bonusMonths", sql.Int, row.BonusMonths);
  request.input("genericArtwork", sql.Bit, row.GenericArtwork);
  request.input("salesRep", sql.Int, row.SalesRep);
  request.input("estimatedStartDate", sql.Date, row.EstimatedStartDate);
  request.input("estimatedEndDate", sql.Date, row.EstimatedEndDate);
  request.input("evergreenCancelDate", sql.Date, row.EvergreenCancelDate);
  request.input("crmDealId", sql.BigInt, row.CRMDealID);
  request.input("timeSensative", sql.Bit, row.TimeSensative);
  request.input("artApprovalDate", sql.Date, row.ArtApprovalDate);

  // Campaign columns inserted (see SQL COLUMNS REFERENCE above)
  const query = `
    INSERT INTO ${table} (
      Name, StatusID, SignedDate, CreatedDate, LastUpdated, CreatedUserID,
      CampaignDuration, Evergreen, BonusMonths, GenericArtwork, SalesRep,
      EstimatedStartDate, EstimatedEndDate, EvergreenCancelDate, CRMDealID,
      TimeSensative, ArtApprovalDate
    )
    OUTPUT INSERTED.ID AS InsertedCampaignId
    VALUES (
      @name, @statusId, @signedDate, @createdDate, @lastUpdated, @createdUserId,
      @campaignDuration, @evergreen, @bonusMonths, @genericArtwork, @salesRep,
      @estimatedStartDate, @estimatedEndDate, @evergreenCancelDate, @crmDealId,
      @timeSensative, @artApprovalDate
    );
  `;

  const result = await request.query(query);
  return result.recordset[0].InsertedCampaignId;
}

// -----------------------------------------------------------------------------
// Campaign.OrderNumber — set immediately AFTER Campaign INSERT
// Matches Terraboost API: CampaignService.GenerateOrderNumber(campaignId, createdDate)
// Format: YY + MM + (campaignId % 10000) padded to 4 digits → stored as int
// Example: ID 17145, CreatedDate 2015-06-04 → "1506145" → OrderNumber 1506145
// -----------------------------------------------------------------------------

/**
 * Generate order number string from SQL Campaign.ID and CreatedDate.
 * Port of C# GenerateOrderNumber(int campaignId, DateTime createdDate).
 */
function generateOrderNumber(campaignId, createdDate) {
  const d = toDate(createdDate) || new Date();
  const year = String(d.getFullYear()).slice(-2);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const idPart = String(campaignId % 10000).padStart(4, "0");
  return `${year}${month}${idPart}`;
}

/**
 * Step after Campaign INSERT: UPDATE Campaign.OrderNumber.
 * Requires InsertedCampaignId and CreatedDate from the row we just inserted.
 */
async function updateCampaignOrderNumber(pool, table, campaignId, createdDate) {
  const orderNumberStr = generateOrderNumber(campaignId, createdDate);
  const orderNumber = parseInt(orderNumberStr, 10); // API stores as int, same as CampaignService

  const request = pool.request();
  request.input("campaignId", sql.Int, campaignId);
  request.input("orderNumber", sql.Int, orderNumber);

  await request.query(`
    UPDATE ${table}
    SET OrderNumber = @orderNumber
    WHERE ID = @campaignId;
  `);

  return { orderNumber, orderNumberStr };
}

/**
 * Check if CustomerCampaigns link already exists (same Campaign + CustomerLogin).
 * Prevents duplicate link row if migration step is run twice for same campaign id.
 */
async function findSqlCustomerCampaignLink(pool, table, campaignId, customerLoginId) {
  const request = pool.request();
  request.input("campaignId", sql.Int, campaignId);
  request.input("customerLoginId", sql.Int, customerLoginId);

  const result = await request.query(`
    SELECT TOP 1 CampaignID, CustomerLoginID, CustomerID, CreatedDate
    FROM ${table}
    WHERE CampaignID = @campaignId AND CustomerLoginID = @customerLoginId
  `);

  return result.recordset.length ? result.recordset[0] : null;
}

/**
 * INSERT CustomerCampaigns only when link does not already exist.
 * Composite key: (CampaignID, CustomerLoginID).
 */
async function insertCustomerCampaignLinkIfMissing(pool, table, link) {
  const existing = await findSqlCustomerCampaignLink(
    pool,
    table,
    link.campaignId,
    link.customerLoginId
  );
  if (existing) {
    return { inserted: false, alreadyExists: true, existing };
  }

  await insertCustomerCampaignLink(pool, table, link);
  return { inserted: true, alreadyExists: false, existing: null };
}

/**
 * INSERT CustomerCampaigns — ties Campaign.ID to CustomerLogins.ID + CustomerAccount.ID.
 * Prefer insertCustomerCampaignLinkIfMissing() so existing links are not duplicated.
 */
async function insertCustomerCampaignLink(pool, table, link) {
  const request = pool.request();
  request.input("campaignId", sql.Int, link.campaignId);
  request.input("customerLoginId", sql.Int, link.customerLoginId);
  request.input("customerId", sql.Int, link.customerId);
  request.input("createdDate", sql.DateTime, link.createdDate);

  // CustomerCampaigns columns: CampaignID, CustomerLoginID, CustomerID, CreatedDate
  await request.query(`
    INSERT INTO ${table} (CampaignID, CustomerLoginID, CustomerID, CreatedDate)
    VALUES (@campaignId, @customerLoginId, @customerId, @createdDate);
  `);
}

// =============================================================================
// LOGGING — console preview and end-of-run summary (no side effects)
// =============================================================================

function printMappedRowPreview(row) {
  console.log("\n--- Mapped SQL v3 Campaign row (preview) ---");
  console.log(JSON.stringify(row, null, 2));
}

/** Prints what Mongo/SQL did this run; dry_run section lists what WOULD happen. */
function printMigrationSummary(summary) {
  const line = "=".repeat(72);
  console.log(`\n${line}`);
  console.log("MIGRATION COMPLETE — SUMMARY");
  console.log(line);

  console.log("\n[MONGO] Campaign migrated");
  console.log(`  _id:              ${summary.mongoCampaignId}`);
  console.log(`  campaign_status:  ${summary.mongoCampaignStatus ?? "(none)"}`);
  if (summary.sqlStatusName) {
    console.log(`  sql StatusID:     ${summary.campaignStatusId} (${summary.sqlStatusName})`);
    console.log(`  status lookup:    ${summary.statusLookupSource ?? "(none)"}`);
  }
  console.log(`  customer:         ${summary.mongoCustomerId ?? "(none)"}`);
  console.log(`  customer email:   ${summary.mongoCustomerEmail ?? "(none)"} (${summary.mongoCustomerEmailField ?? "n/a"})`);
  if (summary.sqlCustomerEmail) {
    console.log(`  sql customer:     CustomerLoginID ${summary.customerLoginId}, Email ${summary.sqlCustomerEmail}`);
  }
  console.log(`  salesrep (mongo): ${summary.mongoSalesRepId ?? "(none)"}`);
  if (summary.salesRepUserId != null) {
    console.log(`  salesrep (sql):   Users.ID ${summary.salesRepUserId} (${summary.sqlSalesRepEmail ?? "n/a"})`);
    console.log(`  salesrep lookup:  ${summary.salesRepMatchType ?? "(none)"}`);
  }
  console.log(`  short_url:        ${summary.mongoShortUrl ?? "(none)"}`);
  console.log(`  created:          ${summary.mongoCreated ?? "(none)"}`);
  console.log(`  campaign_amount:  ${summary.mongoCampaignAmount ?? "(none)"}`);
  console.log(`  collection:       ${summary.mongoCollection}`);
  console.log(`  database:         ${summary.mongoDatabase}`);

  console.log("\n[SQL] Database");
  console.log(`  connection:       ${summary.sqlDatabase}`);
  console.log(`  dry_run:          ${summary.dryRun ? "yes (no writes)" : "no"}`);

  if (summary.dryRun) {
    console.log("\n[SQL] Table effects");
    console.log("  (dry run — no rows inserted)");
    if (summary.customerAccountPreview) {
      console.log(`  ${SQL_CUSTOMER_ACCOUNT_TABLE}: would INSERT`);
      console.log(`    CompanyName:    ${summary.customerAccountPreview.CompanyName}`);
    }
    if (summary.customerLoginPreview) {
      console.log(`  ${SQL_CUSTOMER_LOGIN_TABLE}: would INSERT`);
      console.log(`    Email:          ${summary.customerLoginPreview.Email}`);
    }
    if (summary.salesRepUserPreview) {
      console.log(`  ${SQL_USERS_TABLE}: would INSERT (sales rep)`);
      console.log(`    Email:          ${summary.salesRepUserPreview.Email}`);
      console.log(`    Name:           ${summary.salesRepUserPreview.FirstName ?? ""} ${summary.salesRepUserPreview.LastName ?? ""}`);
    }
    console.log(`  ${SQL_CAMPAIGN_TABLE}: would UPDATE OrderNumber after INSERT (needs new Campaign.ID)`);
    if (summary.orderNumberPreview) {
      console.log(`    OrderNumber:    ${summary.orderNumberPreview} (preview from CreatedDate)`);
    }
    if (summary.customerLoginId != null) {
      console.log(`  CustomerCampaign would link: CampaignID=(new), CustomerLoginID=${summary.customerLoginId}`);
    } else if (summary.customerLoginPreview) {
      console.log("  CustomerCampaign would link after customer create + campaign insert");
    }
    console.log(line);
    return;
  }

  console.log("\n[SQL] Table effects");

  if (summary.salesRepUserInserted) {
    console.log(`  ${SQL_USERS_TABLE}`);
    console.log("    action:         INSERT (1 row, sales rep)");
    console.log(`    ID:             ${summary.insertedSalesRepUserId}`);
    console.log(`    Email:          ${summary.sqlSalesRepEmail}`);
  }

  if (summary.customerAccountInserted) {
    console.log(`  ${SQL_CUSTOMER_ACCOUNT_TABLE}`);
    console.log("    action:         INSERT (1 row)");
    console.log(`    ID:             ${summary.insertedCustomerAccountId}`);
    console.log(`    CompanyName:    ${summary.customerAccountCompanyName ?? "(n/a)"}`);
  }

  if (summary.customerLoginInserted) {
    console.log(`  ${SQL_CUSTOMER_LOGIN_TABLE}`);
    console.log("    action:         INSERT (1 row)");
    console.log(`    ID:             ${summary.insertedCustomerLoginId}`);
    console.log(`    CustomerID:     ${summary.customerId}`);
    console.log(`    Email:          ${summary.sqlCustomerEmail}`);
  }

  if (summary.campaignInserted) {
    console.log(`  ${summary.campaignTable}`);
    console.log("    action:         INSERT (1 row)");
    console.log(`    Campaign.ID:    ${summary.insertedCampaignId}`);
    console.log(`    Name:           ${summary.campaignName}`);
    console.log(`    StatusID:       ${summary.campaignStatusId ?? "NULL"}`);
    console.log(`    SalesRep:       ${summary.salesRepUserId ?? "NULL"}`);
    console.log(`    SignedDate:     ${summary.campaignSignedDate ?? "NULL"}`);
    if (summary.orderNumberUpdated) {
      console.log("    action:         UPDATE OrderNumber (after insert)");
      console.log(`    OrderNumber:    ${summary.orderNumber}`);
    }
  } else {
    console.log(`  ${summary.campaignTable}`);
    console.log("    action:         (no insert)");
    console.log(`    reason:         ${summary.campaignSkipReason ?? "unknown"}`);
  }

  console.log(`  ${summary.customerCampaignTable}`);
  if (summary.customerCampaignInserted) {
    console.log("    action:         INSERT (1 row)");
    console.log(`    CampaignID:     ${summary.insertedCampaignId}`);
    console.log(`    CustomerLoginID: ${summary.customerLoginId}`);
    console.log(`    CustomerID:     ${summary.customerId ?? "NULL"}`);
  } else if (summary.customerCampaignAlreadyExists) {
    console.log("    action:         (no insert — link already exists)");
    console.log(`    CampaignID:     ${summary.insertedCampaignId}`);
    console.log(`    CustomerLoginID: ${summary.customerLoginId}`);
  } else {
    console.log("    action:         (no insert)");
    console.log(`    reason:         ${summary.customerCampaignSkipReason ?? "skipped"}`);
  }

  console.log("\n[SQL] Rows affected total");
  const userRows = summary.salesRepUserInserted ? 1 : 0;
  const accountRows = summary.customerAccountInserted ? 1 : 0;
  const loginRows = summary.customerLoginInserted ? 1 : 0;
  const campaignRows = summary.campaignInserted ? 1 : 0;
  const orderNumberRows = summary.orderNumberUpdated ? 1 : 0;
  const linkRows = summary.customerCampaignInserted ? 1 : 0;
  console.log(`  Users:            +${userRows}`);
  console.log(`  CustomerAccount:  +${accountRows}`);
  console.log(`  CustomerLogins:   +${loginRows}`);
  console.log(`  Campaign:         +${campaignRows}`);
  console.log(`  Campaign UPDATE:  +${orderNumberRows} (OrderNumber)`);
  console.log(`  CustomerCampaign: +${linkRows}`);
  console.log(
    `  total:            +${userRows + accountRows + loginRows + campaignRows + orderNumberRows + linkRows}`
  );

  console.log(line);
}

// =============================================================================
// Per-campaign migration (exported for bulk CSV script; same steps as original main)
// =============================================================================

/** One SQL connection + STATUSES lookup map — reuse for every row in bulk CSV. */
export async function createMigrationContext(
  connectionString = SQL_V3_CONNECTION_STRING
) {
  const pool = await connectSql(connectionString);
  const statusRows = await fetchAllCampaignStatusesFromSql(pool);
  const statusLookup = buildCampaignStatusLookupMap(statusRows);
  return { pool, statusRows, statusLookup };
}

function createEmptySummary(dryRun, mongoCampaignId) {
  return {
    dryRun,
    mongoCampaignId,
    mongoCampaignStatus: null,
    sqlStatusName: null,
    statusLookupSource: null,
    mongoCustomerId: null,
    mongoSalesRepId: null,
    mongoShortUrl: null,
    mongoCreated: null,
    mongoCampaignAmount: null,
    mongoCollection: null,
    mongoDatabase: null,
    sqlDatabase: SQL_V3_CONNECTION_STRING.match(/Database=([^;]+)/i)?.[1] ?? "(unknown)",
    campaignTable: SQL_CAMPAIGN_TABLE,
    customerCampaignTable: SQL_CUSTOMER_CAMPAIGN_TABLE,
    campaignInserted: false,
    customerCampaignInserted: false,
    insertedCampaignId: null,
    campaignName: null,
    campaignStatusId: null,
    campaignSignedDate: null,
    customerLoginId: null,
    customerId: null,
    mongoCustomerEmail: null,
    mongoCustomerEmailField: null,
    sqlCustomerEmail: null,
    customerMatchType: null,
    campaignSkipReason: null,
    customerCampaignSkipReason: null,
    customerCampaignAlreadyExists: false,
    orderNumber: null,
    orderNumberUpdated: false,
    customerAccountInserted: false,
    customerLoginInserted: false,
    insertedCustomerAccountId: null,
    insertedCustomerLoginId: null,
    customerAccountCompanyName: null,
    customerAccountPreview: null,
    customerLoginPreview: null,
    salesRepUserId: null,
    sqlSalesRepEmail: null,
    salesRepMatchType: null,
    mongoAdminEmail: null,
    mongoAdminFullName: null,
    salesRepUserInserted: false,
    insertedSalesRepUserId: null,
    salesRepUserPreview: null,
    orderNumberPreview: null,
    error: null,
  };
}

/**
 * Migrate one Mongo campaign → SQL v3 (full logic from this file).
 * bulk script calls with verbose:false; single script uses verbose:true.
 */
export async function migrateOneCampaign(pool, mongoCampaignId, options = {}) {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose !== false;
  const statusLookup = options.statusLookup;
  const logPrefix = options.logPrefix ?? "";

  if (!/^[a-f0-9]{24}$/i.test(mongoCampaignId)) {
    return {
      ok: false,
      summary: createEmptySummary(dryRun, mongoCampaignId),
      error: "Invalid Mongo campaign ObjectId",
    };
  }

  const mongoConfig = getMongoConfig();
  const mongoDoc = await fetchMongoCampaign(mongoCampaignId);
  if (!mongoDoc) {
    return {
      ok: false,
      summary: createEmptySummary(dryRun, mongoCampaignId),
      error: `Campaign not found in Mongo: ${mongoCampaignId}`,
    };
  }

  const mongoCustomerHex = normalizeObjectIdHex(mongoDoc.customer);
  const mongoCustomer = mongoCustomerHex
    ? await fetchMongoCustomerById(mongoCustomerHex)
    : { doc: null, email: null, emailField: null };

  const sqlRow = mapMongoCampaignToSqlV3Row(mongoDoc, mongoCustomer.doc);

  const summary = createEmptySummary(dryRun, mongoCampaignId);
  summary.mongoCampaignStatus = mongoDoc.campaign_status;
  summary.mongoCustomerId = normalizeObjectIdHex(mongoDoc.customer);
  summary.mongoSalesRepId = normalizeObjectIdHex(mongoDoc.salesrep);
  summary.mongoShortUrl = mongoDoc.short_url;
  summary.mongoCreated = mongoDoc.created ? toDate(mongoDoc.created)?.toISOString() : null;
  summary.mongoCampaignAmount = mongoDoc.campaign_amount;
  summary.mongoCollection = mongoConfig.byCustomerCollection;
  summary.mongoDatabase = mongoConfig.dbName;
  summary.campaignName = sqlRow.Name;
  summary.campaignStatusId = sqlRow.StatusID;
  summary.campaignSignedDate = sqlRow.SignedDate?.toISOString?.() ?? sqlRow.SignedDate;

  try {
    const statusMatch = mapMongoCampaignStatusToSqlStatusId(
      mongoDoc.campaign_status,
      statusLookup
    );
    sqlRow.StatusID = statusMatch.statusId;
    summary.campaignStatusId = statusMatch.statusId;
    summary.sqlStatusName = statusMatch.statusName;
    summary.statusLookupSource = statusMatch.matchType
      ? `${SQL_STATUS_TABLE} — ${statusMatch.matchType}`
      : null;

    if (verbose && statusMatch.statusId != null) {
      console.log(
        `${logPrefix}\nStatus mapped: Mongo "${mongoDoc.campaign_status}" → SQL StatusID ${statusMatch.statusId} ("${statusMatch.statusName}")`
      );
      console.log(`${logPrefix}  match: ${statusMatch.matchType}`);
    } else if (verbose && mongoDoc.campaign_status) {
      console.warn(
        `${logPrefix}Warning: Mongo campaign_status="${mongoDoc.campaign_status}" did not match any SQL StatusName.`
      );
    }

    const salesRepLink = await resolveSalesRepForCampaign(
      pool,
      normalizeObjectIdHex(mongoDoc.salesrep),
      { dryRun }
    );
    sqlRow.SalesRep = salesRepLink.salesRepUserId;
    summary.salesRepUserId = salesRepLink.salesRepUserId;
    summary.sqlSalesRepEmail = salesRepLink.sqlUserEmail;
    summary.salesRepMatchType = salesRepLink.matchType;
    summary.mongoAdminEmail = salesRepLink.mongoAdminEmail;
    summary.mongoAdminFullName = salesRepLink.mongoAdminFullName;
    summary.salesRepUserInserted = salesRepLink.userCreated === true;
    summary.insertedSalesRepUserId = salesRepLink.insertedUserId;
    summary.salesRepUserPreview = salesRepLink.userPreview;

    if (verbose && salesRepLink.salesRepUserId != null) {
      console.log(
        `${logPrefix}\nSales rep: Mongo admin ${salesRepLink.mongoAdminHex} (${salesRepLink.mongoAdminEmailField}="${salesRepLink.mongoAdminEmail}") → SQL Users.ID ${salesRepLink.salesRepUserId}`
      );
      console.log(`${logPrefix}  via: ${salesRepLink.matchType}`);
    } else if (verbose && salesRepLink.userPreview && dryRun) {
      console.log(
        `${logPrefix}\nSales rep would be created: ${salesRepLink.mongoAdminFullName ?? "(no name)"} <${salesRepLink.mongoAdminEmail}>`
      );
    } else if (verbose && normalizeObjectIdHex(mongoDoc.salesrep) && salesRepLink.skipReason) {
      console.warn(`${logPrefix}Warning (sales rep): ${salesRepLink.skipReason}`);
    }

    const customerLink = await resolveCustomerForCampaign(
      pool,
      sqlRow.customerLink.mongoCustomerHex,
      { dryRun }
    );
    sqlRow.customerLink = customerLink;
    summary.mongoCustomerEmail = customerLink.mongoEmail;
    summary.mongoCustomerEmailField = customerLink.mongoEmailField;
    summary.customerLoginId = customerLink.customerLoginId;
    summary.customerId = customerLink.customerId;
    summary.sqlCustomerEmail = customerLink.sqlEmail;
    summary.customerMatchType = customerLink.matchType;
    summary.customerAccountInserted = customerLink.customerAccountCreated === true;
    summary.customerLoginInserted = customerLink.customerLoginCreated === true;
    summary.insertedCustomerAccountId = customerLink.insertedCustomerAccountId;
    summary.insertedCustomerLoginId = customerLink.insertedCustomerLoginId;
    summary.customerAccountCompanyName = customerLink.customerAccountPreview?.CompanyName ?? null;
    summary.customerAccountPreview = customerLink.customerAccountPreview;
    summary.customerLoginPreview = customerLink.customerLoginPreview;

    if (verbose && customerLink.customerLoginId != null) {
      console.log(
        `${logPrefix}\nCustomer resolved: Mongo ${customerLink.mongoEmailField}="${customerLink.mongoEmail}" → SQL CustomerLoginID ${customerLink.customerLoginId} (CustomerID ${customerLink.customerId ?? "NULL"})`
      );
      console.log(`${logPrefix}  via: ${customerLink.matchType}`);
    } else if (verbose && customerLink.customerAccountPreview && dryRun) {
      console.log(
        `${logPrefix}\nCustomer would be created from Mongo (${customerLink.mongoEmailField}="${customerLink.mongoEmail}")`
      );
      console.log(`${logPrefix}  ${SQL_CUSTOMER_ACCOUNT_TABLE}.CompanyName: ${customerLink.customerAccountPreview.CompanyName}`);
      console.log(`${logPrefix}  ${SQL_CUSTOMER_LOGIN_TABLE}.Email: ${customerLink.customerLoginPreview?.Email}`);
    } else if (verbose && INSERT_CUSTOMER_CAMPAIGN_LINK && customerLink.skipReason) {
      console.warn(`${logPrefix}Warning: ${customerLink.skipReason}`);
    }

    if (verbose) {
      printMappedRowPreview(sqlRow);
    }

    summary.orderNumberPreview = `(YYMM#### after insert; CreatedDate ${sqlRow.CreatedDate?.toISOString?.() ?? sqlRow.CreatedDate})`;

    if (dryRun) {
      if (verbose) {
        printMigrationSummary(summary);
      }
      return { ok: true, summary };
    }

    summary.insertedCampaignId = await insertCampaignRow(pool, SQL_CAMPAIGN_TABLE, sqlRow);
    summary.campaignInserted = true;
    if (verbose) {
      console.log(`${logPrefix}\nInserted SQL Campaign.ID: ${summary.insertedCampaignId}`);
    }

    const orderResult = await updateCampaignOrderNumber(
      pool,
      SQL_CAMPAIGN_TABLE,
      summary.insertedCampaignId,
      sqlRow.CreatedDate
    );
    summary.orderNumber = orderResult.orderNumber;
    summary.orderNumberUpdated = true;
    if (verbose) {
      console.log(
        `${logPrefix}Set Campaign.OrderNumber: ${orderResult.orderNumber} (from ID ${summary.insertedCampaignId}, CreatedDate ${sqlRow.CreatedDate?.toISOString?.() ?? sqlRow.CreatedDate})`
      );
    }

    if (INSERT_CUSTOMER_CAMPAIGN_LINK) {
      if (customerLink.customerLoginId == null) {
        summary.customerCampaignSkipReason = customerLink.skipReason ?? "Customer not resolved";
        if (verbose) {
          console.warn(`${logPrefix}Skipped CustomerCampaign: ${summary.customerCampaignSkipReason}`);
        }
      } else {
        const linkResult = await insertCustomerCampaignLinkIfMissing(
          pool,
          SQL_CUSTOMER_CAMPAIGN_TABLE,
          {
            campaignId: summary.insertedCampaignId,
            customerLoginId: customerLink.customerLoginId,
            customerId: customerLink.customerId,
            createdDate: sqlRow.CreatedDate,
          }
        );
        if (linkResult.alreadyExists) {
          summary.customerCampaignAlreadyExists = true;
          summary.customerCampaignSkipReason =
            "CustomerCampaigns row already exists (CampaignID + CustomerLoginID)";
          if (verbose) {
            console.log(
              `${logPrefix}CustomerCampaign already linked: CampaignID=${summary.insertedCampaignId}, CustomerLoginID=${customerLink.customerLoginId} (no insert)`
            );
          }
        } else {
          summary.customerCampaignInserted = true;
          if (verbose) {
            console.log(
              `${logPrefix}Linked CustomerCampaign: CampaignID=${summary.insertedCampaignId}, CustomerLoginID=${customerLink.customerLoginId}, Email=${customerLink.sqlEmail}`
            );
          }
        }
      }
    } else {
      summary.customerCampaignSkipReason = "INSERT_CUSTOMER_CAMPAIGN_LINK is false";
    }

    if (verbose) {
      printMigrationSummary(summary);
    }
    return { ok: true, summary };
  } catch (error) {
    summary.error = error.message;
    if (verbose) {
      console.error(`${logPrefix}Migration failed:`, error.message);
    }
    return { ok: false, summary, error: error.message };
  }
}

// =============================================================================
// MAIN — single campaign entry point (uses migrateOneCampaign with full logging)
// =============================================================================

async function main() {
  const dryRun = DRY_RUN || getCliFlag(process.argv, "--dry-run");
  const mongoCampaignId = MONGO_CAMPAIGN_ID_TO_MIGRATE.trim();

  if (!/^[a-f0-9]{24}$/i.test(mongoCampaignId)) {
    console.error("Invalid MONGO_CAMPAIGN_ID_TO_MIGRATE at top of this file.");
    process.exit(1);
  }

  console.log(`Mongo campaign to migrate: ${mongoCampaignId}`);
  console.log(`Dry run: ${dryRun ? "yes" : "no"}`);

  const ctx = await createMigrationContext();
  try {
    console.log(
      `\nLoaded ${ctx.statusRows.length} statuses from ${SQL_STATUS_TABLE} (StatusGroup="${SQL_STATUS_GROUP_FOR_CAMPAIGN}")`
    );
    for (const row of ctx.statusRows) {
      console.log(`  ID ${row.ID}: ${row.StatusName}`);
    }

    const result = await migrateOneCampaign(ctx.pool, mongoCampaignId, {
      dryRun,
      statusLookup: ctx.statusLookup,
      verbose: true,
    });

    if (!result.ok) {
      console.error(result.error ?? "Migration failed");
      process.exit(1);
    }
  } finally {
    await ctx.pool.close();
  }
}

// Only run when executed directly (not when bulk script imports this module)
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
