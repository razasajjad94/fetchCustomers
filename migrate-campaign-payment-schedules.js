/**
 * =============================================================================
 * CAMPAIGN PAYMENT SCHEDULES — Mongo payment_schedules → SQL InvoiceHeader + PaymentSchedule
 * =============================================================================
 *
 * FLOW (after Campaign insert + kiosk step):
 *   1. Query mongo paymentschedules where campaign = <mongo_campaign_id>
 *   2. For each row: INSERT InvoiceHeader (CampaignID = SQL Campaign.ID)
 *   3. INSERT PaymentSchedule using values from the InvoiceHeader row just created
 *
 * Mongo collection: paymentschedules (mydb)
 *
 * InvoiceHeader mapping:
 *   invoice_number     → InvoiceNumber
 *   scheduled_date     → InvoiceDate, DueDate (DueDate defaults to InvoiceDate)
 *   payment_status     → InvoiceStatusID (paid=35, unpaid=34, failed*=39)
 *   created            → CreatedDate
 *   note               → InvoiceNotes
 *   campaign           → CampaignID (SQL ID from campaign insert)
 *   amount             → InvoiceTotal
 *   card_charged_date | ach_charged_date → PaidDate
 *
 * PaymentSchedule (derived from InvoiceHeader, not re-read from Mongo):
 *   InvoiceHeaderID  → INSERTED InvoiceHeader.ID
 *   AutoPayDate      → InvoiceHeader.InvoiceDate
 *   PaymentStatus    → map(InvoiceHeader.InvoiceStatusID): 35→19, 39→21, 34→22
 */
import mongodb from "mongodb";
import { getMongoConfig } from "./mongo-config.js";
import { sql } from "./sql-connection.js";

const { MongoClient, ObjectId } = mongodb;

// =============================================================================
// CONFIG
// =============================================================================

const MONGO_PAYMENT_SCHEDULES_COLLECTION = "paymentschedules";

const SQL_INVOICE_HEADER_TABLE = "InvoiceHeader";
const SQL_PAYMENT_SCHEDULE_TABLE = "PaymentSchedule";

/** InvoiceHeader.InvoiceStatusID from mongo payment_status */
const INVOICE_STATUS_PAID = 35;
const INVOICE_STATUS_UNPAID = 34;
const INVOICE_STATUS_FAILED = 39;

/** PaymentSchedule.PaymentStatus from InvoiceHeader.InvoiceStatusID */
const PAYMENT_SCHEDULE_STATUS_FROM_PAID = 19;
const PAYMENT_SCHEDULE_STATUS_FROM_FAILED = 21;
const PAYMENT_SCHEDULE_STATUS_FROM_UNPAID = 22;

/** PaymentSchedule.CreatedUser is NOT NULL — migration sentinel (no Users FK) */
const DEFAULT_PAYMENT_SCHEDULE_CREATED_USER = -1;

// =============================================================================
// HELPERS
// =============================================================================

function formatMigrationError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  const parts = [err.message || String(err)];
  if (err.number != null) parts.push(`SQL ${err.number}`);
  if (err.state != null) parts.push(`state ${err.state}`);
  return parts.join(" | ");
}

function scheduleRef(doc) {
  return doc?._id ? String(doc._id) : "(unknown schedule)";
}

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateOnly(value) {
  const d = toDate(value);
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

function truncate(value, maxLen) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

function pickFirstField(doc, fieldNames) {
  if (!doc) return null;
  for (const name of fieldNames) {
    const v = doc[name];
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

/**
 * Mongo payment_status → InvoiceHeader.InvoiceStatusID
 * paid=35, unpaid=34, failed_1..failed_4 and other failed* → 39
 */
function mapMongoPaymentStatusToInvoiceStatusId(paymentStatus) {
  const s = String(paymentStatus ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (s === "paid") return INVOICE_STATUS_PAID;
  if (s === "unpaid") return INVOICE_STATUS_UNPAID;
  if (
    s === "failed_1" ||
    s === "failed_2" ||
    s === "failed_3" ||
    s === "failed_4" ||
    s.startsWith("failed")
  ) {
    return INVOICE_STATUS_FAILED;
  }
  return null;
}

/**
 * InvoiceHeader.InvoiceStatusID → PaymentSchedule.PaymentStatus
 */
function mapInvoiceStatusToPaymentScheduleStatus(invoiceStatusId) {
  if (invoiceStatusId === INVOICE_STATUS_PAID) return PAYMENT_SCHEDULE_STATUS_FROM_PAID;
  if (invoiceStatusId === INVOICE_STATUS_FAILED) return PAYMENT_SCHEDULE_STATUS_FROM_FAILED;
  if (invoiceStatusId === INVOICE_STATUS_UNPAID) return PAYMENT_SCHEDULE_STATUS_FROM_UNPAID;
  return null;
}

// =============================================================================
// MONGO
// =============================================================================

async function fetchMongoPaymentSchedulesForCampaign(mongoCampaignIdHex) {
  if (!mongoCampaignIdHex) return [];

  const config = getMongoConfig();
  const campaignOid = new ObjectId(mongoCampaignIdHex);
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    return await client
      .db(config.dbName)
      .collection(MONGO_PAYMENT_SCHEDULES_COLLECTION)
      .find({
        $or: [{ campaign: campaignOid }, { campaign: mongoCampaignIdHex }],
      })
      .toArray();
  } finally {
    await client.close();
  }
}

// =============================================================================
// MAPPING
// =============================================================================

function mapMongoScheduleToInvoiceHeader(mongoDoc, sqlCampaignId) {
  const invoiceStatusId = mapMongoPaymentStatusToInvoiceStatusId(mongoDoc.payment_status);
  const invoiceDate = toDateOnly(mongoDoc.scheduled_date);
  const created = toDate(mongoDoc.created) || new Date();
  const paidDate =
    toDate(mongoDoc.card_charged_date) || toDate(mongoDoc.ach_charged_date) || null;

  const invoiceNumber =
    truncate(
      pickFirstField(mongoDoc, ["invoice_number", "invoiceNumber", "InvoiceNumber"]),
      50
    ) || `PS-${String(mongoDoc._id).slice(-12)}`;

  const amount = mongoDoc.amount != null ? Number(mongoDoc.amount) : 0;
  const invoiceTotal = Number.isFinite(amount) ? amount : 0;

  return {
    InvoiceNumber: invoiceNumber,
    InvoiceDate: invoiceDate,
    CampaignID: sqlCampaignId,
    DueDate: invoiceDate,
    InvoiceTotal: invoiceTotal,
    InvoiceStatusID: invoiceStatusId,
    InvoiceNotes: truncate(pickFirstField(mongoDoc, ["note", "notes", "invoice_notes"]), 500),
    PaidDate: paidDate,
    Voided: 0,
    CreatedDate: created,
    LastUpdated: toDate(mongoDoc.updated) || created,
    CreatedUser: null,
    UpdatedUser: null,
  };
}

/** PaymentSchedule row — all payment fields come from InvoiceHeader (not Mongo). */
function mapInvoiceHeaderToPaymentSchedule(invoiceHeaderRow, invoiceHeaderId) {
  const paymentStatus = mapInvoiceStatusToPaymentScheduleStatus(
    invoiceHeaderRow.InvoiceStatusID
  );

  return {
    InvoiceHeaderID: invoiceHeaderId,
    AutoPayDate: invoiceHeaderRow.InvoiceDate,
    PaymentStatus: paymentStatus,
    CreatedDate: invoiceHeaderRow.CreatedDate || new Date(),
    LastUpdated: invoiceHeaderRow.LastUpdated,
    ProcessorResponse: null,
    CreatedUser: DEFAULT_PAYMENT_SCHEDULE_CREATED_USER,
    UpdatedUser: null,
  };
}

// =============================================================================
// SQL INSERTS
// =============================================================================

async function insertInvoiceHeaderRow(pool, row) {
  const request = pool.request();
  request.input("invoiceNumber", sql.VarChar(50), row.InvoiceNumber);
  request.input("invoiceDate", sql.Date, row.InvoiceDate);
  request.input("campaignID", sql.Int, row.CampaignID);
  request.input("dueDate", sql.Date, row.DueDate);
  request.input("invoiceTotal", sql.Money, row.InvoiceTotal);
  request.input("invoiceStatusID", sql.Int, row.InvoiceStatusID);
  request.input("invoiceNotes", sql.VarChar(500), row.InvoiceNotes);
  request.input("paidDate", sql.DateTime, row.PaidDate);
  request.input("voided", sql.Bit, row.Voided);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("lastUpdated", sql.DateTime, row.LastUpdated);
  request.input("createdUser", sql.Int, row.CreatedUser ?? null);
  request.input("updatedUser", sql.Int, row.UpdatedUser ?? null);

  const result = await request.query(`
    INSERT INTO ${SQL_INVOICE_HEADER_TABLE} (
      InvoiceNumber, InvoiceDate, CampaignID, DueDate, InvoiceTotal, InvoiceStatusID,
      InvoiceNotes, PaidDate, Voided, CreatedDate, LastUpdated, CreatedUser, UpdatedUser
    )
    OUTPUT INSERTED.ID AS InsertedInvoiceHeaderId
    VALUES (
      @invoiceNumber, @invoiceDate, @campaignID, @dueDate, @invoiceTotal, @invoiceStatusID,
      @invoiceNotes, @paidDate, @voided, @createdDate, @lastUpdated, @createdUser, @updatedUser
    );
  `);

  return result.recordset[0].InsertedInvoiceHeaderId;
}

async function insertPaymentScheduleRow(pool, row) {
  const request = pool.request();
  request.input("invoiceHeaderID", sql.Int, row.InvoiceHeaderID);
  request.input("autoPayDate", sql.Date, row.AutoPayDate);
  request.input("paymentStatus", sql.Int, row.PaymentStatus);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("lastUpdated", sql.DateTime, row.LastUpdated);
  request.input("processorResponse", sql.VarChar(500), row.ProcessorResponse);
  request.input(
    "createdUser",
    sql.Int,
    row.CreatedUser ?? DEFAULT_PAYMENT_SCHEDULE_CREATED_USER
  );
  request.input("updatedUser", sql.Int, row.UpdatedUser ?? null);

  const result = await request.query(`
    INSERT INTO ${SQL_PAYMENT_SCHEDULE_TABLE} (
      InvoiceHeaderID, AutoPayDate, PaymentStatus, CreatedDate, LastUpdated,
      ProcessorResponse, CreatedUser, UpdatedUser
    )
    OUTPUT INSERTED.ID AS InsertedPaymentScheduleId
    VALUES (
      @invoiceHeaderID, @autoPayDate, @paymentStatus, @createdDate, @lastUpdated,
      @processorResponse, @createdUser, @updatedUser
    );
  `);

  return result.recordset[0].InsertedPaymentScheduleId;
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * @param {object} pool - SQL pool
 * @param {string} mongoCampaignIdHex - Mongo campaign _id
 * @param {number} sqlCampaignId - SQL Campaign.ID
 * @param {{ dryRun?: boolean, verbose?: boolean }} options
 */
export async function migrateCampaignPaymentSchedules(
  pool,
  mongoCampaignIdHex,
  sqlCampaignId,
  options = {}
) {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose !== false;

  const stats = {
    ok: true,
    schedulesProcessed: 0,
    invoiceHeadersCreated: 0,
    paymentSchedulesCreated: 0,
    errors: [],
  };

  try {
    const schedules = await fetchMongoPaymentSchedulesForCampaign(mongoCampaignIdHex);
    if (verbose) {
      console.log(
        `  Found ${schedules.length} payment schedule(s) in Mongo (${MONGO_PAYMENT_SCHEDULES_COLLECTION}) for campaign ${mongoCampaignIdHex}`
      );
    }

    if (!schedules.length) {
      return stats;
    }

    for (const mongoDoc of schedules) {
      stats.schedulesProcessed++;

      const invoiceHeaderRow = mapMongoScheduleToInvoiceHeader(mongoDoc, sqlCampaignId);

      if (invoiceHeaderRow.InvoiceStatusID == null) {
        stats.errors.push(
          `[schedule ${scheduleRef(mongoDoc)}] unknown payment_status="${mongoDoc.payment_status}" (expected paid, unpaid, or failed_*)`
        );
        continue;
      }

      if (!invoiceHeaderRow.InvoiceDate) {
        stats.errors.push(
          `[schedule ${scheduleRef(mongoDoc)}] missing scheduled_date (InvoiceDate / AutoPayDate)`
        );
        continue;
      }

      if (dryRun) {
        const paymentSchedulePreview = mapInvoiceHeaderToPaymentSchedule(
          invoiceHeaderRow,
          -1
        );
        if (paymentSchedulePreview.PaymentStatus == null) {
          stats.errors.push(
            `[schedule ${scheduleRef(mongoDoc)}] cannot map InvoiceStatusID ${invoiceHeaderRow.InvoiceStatusID} to PaymentSchedule.PaymentStatus`
          );
          continue;
        }
        stats.invoiceHeadersCreated++;
        stats.paymentSchedulesCreated++;
        if (verbose) {
          console.log(
            `    [DRY RUN] InvoiceHeader ${invoiceHeaderRow.InvoiceNumber} + PaymentSchedule (status ${paymentSchedulePreview.PaymentStatus})`
          );
        }
        continue;
      }

      try {
        const invoiceHeaderId = await insertInvoiceHeaderRow(pool, invoiceHeaderRow);
        stats.invoiceHeadersCreated++;

        const paymentScheduleRow = mapInvoiceHeaderToPaymentSchedule(
          invoiceHeaderRow,
          invoiceHeaderId
        );

        if (paymentScheduleRow.PaymentStatus == null) {
          stats.errors.push(
            `[schedule ${scheduleRef(mongoDoc)}] InvoiceHeader ID ${invoiceHeaderId}: InvoiceStatusID ${invoiceHeaderRow.InvoiceStatusID} has no PaymentSchedule status mapping`
          );
          continue;
        }

        await insertPaymentScheduleRow(pool, paymentScheduleRow);
        stats.paymentSchedulesCreated++;

        if (verbose) {
          console.log(
            `    InvoiceHeader ID ${invoiceHeaderId} (${invoiceHeaderRow.InvoiceNumber}) → PaymentSchedule status ${paymentScheduleRow.PaymentStatus}`
          );
        }
      } catch (insertErr) {
        stats.errors.push(
          `[schedule ${scheduleRef(mongoDoc)}] ${formatMigrationError(insertErr)}`
        );
      }
    }
  } catch (error) {
    stats.ok = false;
    stats.errors.push(`Payment schedule migration fatal: ${formatMigrationError(error)}`);
  }

  return stats;
}
