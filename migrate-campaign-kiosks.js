/**
 * =============================================================================
 * CAMPAIGN KIOSKS MIGRATION — Mongo bookings/displays/kiosks/venues → SQL
 * =============================================================================
 *
 * FLOW (called after Campaign insert):
 *   1. Query mongo bookings where campaign = <mongo_campaign_id>
 *   2. For each booking → get display → extract kiosk string + venue ObjectId
 *   3. Check SQL Kiosks by ImportKioskID (from display.kiosk)
 *   4. If kiosk missing:
 *      - Query mongo venues by display.venue
 *      - Check SQL Venues by ImportVenueID
 *      - If venue missing: INSERT Venues
 *      - INSERT Kiosks with VenueID
 *   5. INSERT CampaignKiosks with mapped values
 *
 * CRITICAL - NO UPDATES:
 *   - Existing Venues are REUSED (never updated)
 *   - Existing Kiosks are REUSED (never updated)
 *   - Only INSERT new rows when ImportVenueID / ImportKioskID not found
 *   - CampaignKiosks: one INSERT per unique (CampaignID, KioskID, ReservationStart,
 *     ReservationEnd). Mongo books one display FACE per booking and many faces share one
 *     kiosk string (e.g. import_display_id 22382C1..22382C17 → kiosk "22382C"), so several
 *     bookings can resolve to the same SQL KioskID — duplicates are skipped, not inserted.
 *
 * ASSUMPTIONS:
 *   - Pricing fields (ContractPrice, EvergreenPrice) mapped from mongo booking if available,
 *     otherwise defaults to 0 (checks: contract_price, price, evergreen_price, monthly_price)
 *   - KioskAdPlacementID default = 1 (adjust if needed)
 *   - Venues.CreateUserID = -1 (NOT NULL migration sentinel)
 *   - Kiosks / CampaignKiosks CreatedUserID = NULL where nullable
 *   - Deduplication: Venues by ImportVenueID, Kiosks by ImportKioskID
 */
import mongodb from "mongodb";
import { getMongoConfig } from "./mongo-config.js";
import { sql } from "./sql-connection.js";

const { MongoClient, ObjectId } = mongodb;

// =============================================================================
// CONFIG
// =============================================================================

const MONGO_BOOKINGS_COLLECTION = "bookings";
const MONGO_DISPLAYS_COLLECTION = "displays";
const MONGO_VENUES_COLLECTION = "venues";
const MONGO_KIOSKS_COLLECTION = "kiosks";

const SQL_CAMPAIGN_KIOSKS_TABLE = "CampaignKiosks";
const SQL_KIOSKS_TABLE = "Kiosks";
const SQL_VENUES_TABLE = "Venues";

/** Venues.CreateUserID is NOT NULL — migration sentinel (same as PaymentSchedule.CreatedUser) */
const DEFAULT_VENUE_CREATE_USER_ID = -1;

const DEFAULT_KIOSK_AD_PLACEMENT_ID = 1; // Adjust based on your SQL data
const DEFAULT_CONTRACT_PRICE = 0; // Placeholder (skip pricing per user request)
const DEFAULT_EVERGREEN_PRICE = 0; // Placeholder

/** Format mssql / generic errors for logs and CSV. */
function formatMigrationError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  const parts = [err.message || String(err)];
  if (err.number != null) parts.push(`SQL ${err.number}`);
  if (err.state != null) parts.push(`state ${err.state}`);
  if (err.class != null) parts.push(`class ${err.class}`);
  if (err.procName) parts.push(`proc ${err.procName}`);
  if (err.lineNumber != null) parts.push(`line ${err.lineNumber}`);
  return parts.join(" | ");
}

function bookingRef(booking) {
  return booking?._id ? String(booking._id) : "(unknown booking)";
}

// =============================================================================
// MONGO QUERIES
// =============================================================================

/**
 * Load all bookings for a campaign from Mongo.
 * Returns array of booking docs with display ObjectId.
 */
async function fetchMongoBookingsForCampaign(mongoCampaignIdHex) {
  if (!mongoCampaignIdHex) return [];

  const config = getMongoConfig();
  const campaignOid = new ObjectId(mongoCampaignIdHex);
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const bookings = await client
      .db(config.dbName)
      .collection(MONGO_BOOKINGS_COLLECTION)
      .find({
        $or: [{ campaign: campaignOid }, { campaign: mongoCampaignIdHex }],
      })
      .toArray();
    return bookings;
  } finally {
    await client.close();
  }
}

/**
 * Load display doc from Mongo by ObjectId.
 * Returns { doc, kiosk: string, venueObjectId: string }
 */
async function fetchMongoDisplay(displayObjectIdHex) {
  if (!displayObjectIdHex) return { doc: null, kiosk: null, venueObjectId: null };

  const config = getMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.dbName)
      .collection(MONGO_DISPLAYS_COLLECTION)
      .findOne({ _id: new ObjectId(displayObjectIdHex) });

    if (!doc) return { doc: null, kiosk: null, venueObjectId: null };

    return {
      doc,
      kiosk: doc.kiosk ? String(doc.kiosk).trim() : null,
      venueObjectId: doc.venue ? String(doc.venue) : null,
    };
  } finally {
    await client.close();
  }
}

/**
 * Load venue doc from Mongo by ObjectId.
 */
async function fetchMongoVenue(venueObjectIdHex) {
  if (!venueObjectIdHex) return null;

  const config = getMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    const doc = await client
      .db(config.dbName)
      .collection(MONGO_VENUES_COLLECTION)
      .findOne({ _id: new ObjectId(venueObjectIdHex) });
    return doc;
  } finally {
    await client.close();
  }
}

// =============================================================================
// SQL LOOKUPS
// =============================================================================

/**
 * Find SQL Kiosk by ImportKioskID (from mongo display.kiosk string).
 * Returns { id, venueId } or null.
 * 
 * IMPORTANT: READ-ONLY - does NOT update existing kiosk data.
 * If found, existing kiosk is REUSED as-is (no data changes).
 */
async function findSqlKioskByImportId(pool, importKioskId) {
  if (!importKioskId) return null;

  const request = pool.request();
  request.input("importKioskId", sql.VarChar(50), importKioskId);

  const result = await request.query(`
    SELECT TOP 1 ID, VenueID
    FROM ${SQL_KIOSKS_TABLE}
    WHERE ImportKioskID = @importKioskId
  `);

  if (!result.recordset.length) return null;
  return { id: result.recordset[0].ID, venueId: result.recordset[0].VenueID };
}

/**
 * Find SQL Venue by ImportVenueID (from mongo venue.import_venue_id).
 * Returns { id } or null.
 * 
 * IMPORTANT: READ-ONLY - does NOT update existing venue data.
 * If found, existing venue is REUSED as-is (no data changes).
 */
async function findSqlVenueByImportId(pool, importVenueId) {
  if (!importVenueId) return null;

  const request = pool.request();
  request.input("importVenueId", sql.Int, importVenueId);

  const result = await request.query(`
    SELECT TOP 1 ID
    FROM ${SQL_VENUES_TABLE}
    WHERE ImportVenueID = @importVenueId
  `);

  if (!result.recordset.length) return null;
  return { id: result.recordset[0].ID };
}

/**
 * Check if a CampaignKiosks link already exists for the same
 * (CampaignID, KioskID, ReservationStart, ReservationEnd).
 * Guards against duplicates within one run (multiple Mongo display faces sharing
 * one kiosk string) and across re-runs of the migration.
 */
async function campaignKioskLinkExists(pool, row) {
  const request = pool.request();
  request.input("campaignID", sql.Int, row.CampaignID);
  request.input("kioskID", sql.Int, row.KioskID);
  request.input("reservationStart", sql.Date, row.ReservationStart);
  request.input("reservationEnd", sql.Date, row.ReservationEnd);

  const result = await request.query(`
    SELECT TOP 1 ID
    FROM ${SQL_CAMPAIGN_KIOSKS_TABLE}
    WHERE CampaignID = @campaignID
      AND KioskID = @kioskID
      AND ((ReservationStart = @reservationStart) OR (ReservationStart IS NULL AND @reservationStart IS NULL))
      AND ((ReservationEnd = @reservationEnd) OR (ReservationEnd IS NULL AND @reservationEnd IS NULL))
  `);

  return result.recordset.length > 0;
}

// =============================================================================
// MAPPING — Mongo → SQL rows
// =============================================================================

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function truncate(value, maxLen) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}

/**
 * Parse pricing value from mongo (handles various formats).
 * Returns numeric value or default if invalid/missing.
 */
function parsePrice(value, defaultValue = 0) {
  if (value == null || value === "") return defaultValue;
  const num = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  return isNaN(num) ? defaultValue : num;
}

/**
 * Map mongo venue → SQL Venues row (required fields only).
 */
function mapMongoVenueToSql(mongoDoc) {
  const importVenueId = mongoDoc.import_venue_id;
  const venueName = truncate(mongoDoc.name || `Venue-${importVenueId}`, 100);
  const created = toDate(mongoDoc.created) || new Date();

  return {
    VenueName: venueName,
    Address1: truncate(mongoDoc.address, 255),
    City: truncate(mongoDoc.city, 100),
    State: truncate(mongoDoc.state, 2),
    Zip: truncate(mongoDoc.zip_code, 10),
    County: truncate(mongoDoc.county, 100),
    DMA: truncate(mongoDoc.dma, 100),
    Longitude: truncate(mongoDoc.longitude, 50),
    Latitude: truncate(mongoDoc.latitude, 50),
    StoreNumber: truncate(mongoDoc.store_number, 50),
    Retired: mongoDoc.retired === true ? 1 : 0,
    ImportVenueID: importVenueId ? parseInt(importVenueId, 10) : null,
    CreatedDate: created,
    CreateUserID: DEFAULT_VENUE_CREATE_USER_ID,
    PermanentlyClosed: 0,
    Sellable: 0,
  };
}

/**
 * Map mongo display/kiosk → SQL Kiosks row (required fields only).
 */
function mapMongoKioskToSql(kioskString, venueId) {
  return {
    ImportKioskID: truncate(kioskString, 50),
    VenueID: venueId,
    IsDigital: 0, // Default; adjust if mongo has digital flag
    Sellable: 0, // Default
    Retired: 1, // New migrated kiosks: always Retired = true
    CreatedDate: new Date(),
    CreatedUserID: null,
  };
}

/**
 * Map mongo booking → SQL CampaignKiosks row (required fields only).
 * Pricing fields mapped from mongo if available, otherwise defaults to 0.
 */
function mapBookingToCampaignKiosk(booking, sqlCampaignId, sqlKioskId) {
  const startDate = toDate(booking.booking_start_date);
  const endDate = toDate(booking.booking_end_date);

  // Try common pricing field names from mongo booking
  const contractPrice = parsePrice(
    booking.contract_price ?? booking.contractPrice ?? booking.price,
    DEFAULT_CONTRACT_PRICE
  );
  
  const evergreenPrice = parsePrice(
    booking.evergreen_price ?? booking.evergreenPrice ?? booking.monthly_price,
    DEFAULT_EVERGREEN_PRICE
  );

  return {
    CampaignID: sqlCampaignId,
    KioskID: sqlKioskId,
    ReservationStart: startDate,
    ReservationEnd: endDate,
    Bumpable: 0, // Default
    Boosted: 0, // Default
    ContractPrice: contractPrice,
    EvergreenPrice: evergreenPrice,
    KioskAdPlacementID: DEFAULT_KIOSK_AD_PLACEMENT_ID,
    CreatedDate: toDate(booking.created) || new Date(),
    CreatedUserID: null, // nullable FK to Users — do not use placeholder ID
  };
}

// =============================================================================
// SQL INSERTS
// =============================================================================

/**
 * INSERT Venues → return new ID.
 */
async function insertVenueRow(pool, row) {
  const request = pool.request();
  request.input("venueName", sql.VarChar(100), row.VenueName);
  request.input("address1", sql.VarChar(255), row.Address1);
  request.input("city", sql.VarChar(100), row.City);
  request.input("state", sql.VarChar(2), row.State);
  request.input("zip", sql.VarChar(10), row.Zip);
  request.input("county", sql.VarChar(100), row.County);
  request.input("dma", sql.VarChar(100), row.DMA);
  request.input("longitude", sql.VarChar(50), row.Longitude);
  request.input("latitude", sql.VarChar(50), row.Latitude);
  request.input("storeNumber", sql.VarChar(50), row.StoreNumber);
  request.input("retired", sql.Bit, row.Retired);
  request.input("importVenueID", sql.Int, row.ImportVenueID);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input(
    "createUserID",
    sql.Int,
    row.CreateUserID ?? DEFAULT_VENUE_CREATE_USER_ID
  );
  request.input("permanentlyClosed", sql.Bit, row.PermanentlyClosed);
  request.input("sellable", sql.Bit, row.Sellable);

  const result = await request.query(`
    INSERT INTO ${SQL_VENUES_TABLE} (
      VenueName, Address1, City, State, Zip, County, DMA, Longitude, Latitude,
      StoreNumber, Retired, ImportVenueID, CreatedDate, CreateUserID, PermanentlyClosed, Sellable
    )
    OUTPUT INSERTED.ID
    VALUES (
      @venueName, @address1, @city, @state, @zip, @county, @dma, @longitude, @latitude,
      @storeNumber, @retired, @importVenueID, @createdDate, @createUserID, @permanentlyClosed, @sellable
    );
  `);

  return result.recordset[0].ID;
}

/**
 * INSERT Kiosks → return new ID.
 */
async function insertKioskRow(pool, row) {
  const request = pool.request();
  request.input("importKioskID", sql.VarChar(50), row.ImportKioskID);
  request.input("venueID", sql.Int, row.VenueID);
  request.input("isDigital", sql.Bit, row.IsDigital);
  request.input("sellable", sql.Bit, row.Sellable);
  request.input("retired", sql.Bit, row.Retired);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("createdUserID", sql.Int, row.CreatedUserID ?? null);

  const result = await request.query(`
    INSERT INTO ${SQL_KIOSKS_TABLE} (
      ImportKioskID, VenueID, IsDigital, Sellable, Retired, CreatedDate, CreatedUserID
    )
    OUTPUT INSERTED.ID
    VALUES (
      @importKioskID, @venueID, @isDigital, @sellable, @retired, @createdDate, @createdUserID
    );
  `);

  return result.recordset[0].ID;
}

/**
 * INSERT CampaignKiosks (no return ID needed).
 */
async function insertCampaignKioskRow(pool, row) {
  const request = pool.request();
  request.input("campaignID", sql.Int, row.CampaignID);
  request.input("kioskID", sql.Int, row.KioskID);
  request.input("reservationStart", sql.Date, row.ReservationStart);
  request.input("reservationEnd", sql.Date, row.ReservationEnd);
  request.input("bumpable", sql.Bit, row.Bumpable);
  request.input("boosted", sql.Bit, row.Boosted);
  request.input("contractPrice", sql.Money, row.ContractPrice);
  request.input("evergreenPrice", sql.Money, row.EvergreenPrice);
  request.input("kioskAdPlacementID", sql.Int, row.KioskAdPlacementID);
  request.input("createdDate", sql.DateTime, row.CreatedDate);
  request.input("createdUserID", sql.Int, row.CreatedUserID ?? null);

  await request.query(`
    INSERT INTO ${SQL_CAMPAIGN_KIOSKS_TABLE} (
      CampaignID, KioskID, ReservationStart, ReservationEnd, Bumpable, Boosted,
      ContractPrice, EvergreenPrice, KioskAdPlacementID, CreatedDate, CreatedUserID
    )
    VALUES (
      @campaignID, @kioskID, @reservationStart, @reservationEnd, @bumpable, @boosted,
      @contractPrice, @evergreenPrice, @kioskAdPlacementID, @createdDate, @createdUserID
    );
  `);
}

// =============================================================================
// MAIN MIGRATION LOGIC
// =============================================================================

/**
 * Migrate kiosks for one campaign (called after Campaign insert).
 *
 * @param {object} pool - SQL connection pool
 * @param {string} mongoCampaignIdHex - Mongo campaign _id
 * @param {number} sqlCampaignId - SQL Campaign.ID (from insert); use -1 for dry-run preview
 * @param {object} options - { dryRun: boolean, verbose: boolean }
 * @returns {object} - { ok, bookingsProcessed, venuesCreated, kiosksCreated, campaignKiosksCreated, errors }
 */
export async function migrateCampaignKiosks(pool, mongoCampaignIdHex, sqlCampaignId, options = {}) {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose !== false;

  const stats = {
    ok: true,
    bookingsProcessed: 0,
    venuesCreated: 0,
    venuesReused: 0,
    kiosksCreated: 0,
    kiosksReused: 0,
    campaignKiosksCreated: 0,
    campaignKiosksSkippedDuplicates: 0,
    errors: [],
  };

  // Unique (kiosk, reservation window) links already handled in this run
  const seenLinks = new Set();

  try {
    // 1. Load bookings from Mongo
    const bookings = await fetchMongoBookingsForCampaign(mongoCampaignIdHex);
    if (verbose) {
      console.log(`  Found ${bookings.length} booking(s) in Mongo for campaign ${mongoCampaignIdHex}`);
    }

    if (!bookings.length) {
      return stats;
    }

    // 2. Process each booking
    for (const booking of bookings) {
      stats.bookingsProcessed++;

      const displayObjectId = booking.display ? String(booking.display) : null;
      if (!displayObjectId) {
        stats.errors.push(`[booking ${bookingRef(booking)}] has no display field`);
        continue;
      }

      // 3. Load display → get kiosk string + venue ObjectId
      const display = await fetchMongoDisplay(displayObjectId);
      if (!display.doc) {
        stats.errors.push(
          `[booking ${bookingRef(booking)}] display ${displayObjectId} not found in Mongo (${MONGO_DISPLAYS_COLLECTION})`
        );
        continue;
      }

      if (!display.kiosk) {
        stats.errors.push(
          `[booking ${bookingRef(booking)}] display ${displayObjectId} has no kiosk field (import_display_id=${display.doc.import_display_id ?? "n/a"})`
        );
        continue;
      }

      if (!display.venueObjectId) {
        stats.errors.push(
          `[booking ${bookingRef(booking)}] display ${displayObjectId} has no venue field (kiosk=${display.kiosk})`
        );
        continue;
      }

      // 4. Check if SQL Kiosk exists by ImportKioskID (READ-ONLY lookup, no update)
      let sqlKiosk = await findSqlKioskByImportId(pool, display.kiosk);

      if (sqlKiosk) {
        // Kiosk exists in SQL → REUSE existing ID (no data update)
        stats.kiosksReused++;
        if (verbose) {
          console.log(`    Kiosk ${display.kiosk} exists in SQL (ID ${sqlKiosk.id}) - reusing`);
        }
      } else {
        // Kiosk missing → create NEW kiosk (and venue if needed)
        if (verbose) {
          console.log(`    Kiosk ${display.kiosk} not found, creating NEW...`);
        }

        // 5. Load venue from Mongo
        const mongoVenue = await fetchMongoVenue(display.venueObjectId);
        if (!mongoVenue) {
          stats.errors.push(
            `[booking ${bookingRef(booking)}] venue ${display.venueObjectId} not found in Mongo (${MONGO_VENUES_COLLECTION}) for kiosk ${display.kiosk}`
          );
          continue;
        }

        const importVenueId = mongoVenue.import_venue_id ? parseInt(mongoVenue.import_venue_id, 10) : null;
        let sqlVenueId = null;

        // 6. Check if SQL Venue exists (READ-ONLY lookup, no update)
        const existingVenue = await findSqlVenueByImportId(pool, importVenueId);
        if (existingVenue) {
          // Venue exists in SQL → REUSE existing ID (no data update)
          sqlVenueId = existingVenue.id;
          stats.venuesReused++;
          if (verbose) {
            console.log(`      Venue ImportID ${importVenueId} exists in SQL (ID ${sqlVenueId}) - reusing`);
          }
        } else {
          // Venue missing → INSERT NEW venue
          if (dryRun) {
            sqlVenueId = -1; // Placeholder for dry run
            stats.venuesCreated++;
            if (verbose) {
              console.log(`      [DRY RUN] Would INSERT NEW venue: ${mongoVenue.name}`);
            }
          } else {
            const venueRow = mapMongoVenueToSql(mongoVenue);
            sqlVenueId = await insertVenueRow(pool, venueRow); // INSERT NEW venue
            stats.venuesCreated++;
            if (verbose) {
              console.log(`      Inserted NEW venue: ${mongoVenue.name} (SQL ID ${sqlVenueId})`);
            }
          }
        }

        // 7. INSERT NEW kiosk (never update existing)
        if (dryRun) {
          sqlKiosk = { id: -1, venueId: sqlVenueId };
          stats.kiosksCreated++;
          if (verbose) {
            console.log(`      [DRY RUN] Would INSERT NEW kiosk: ${display.kiosk}`);
          }
        } else {
          const kioskRow = mapMongoKioskToSql(display.kiosk, sqlVenueId);
          const newKioskId = await insertKioskRow(pool, kioskRow); // INSERT NEW kiosk
          sqlKiosk = { id: newKioskId, venueId: sqlVenueId };
          stats.kiosksCreated++;
          if (verbose) {
            console.log(`      Inserted NEW kiosk: ${display.kiosk} (SQL ID ${newKioskId})`);
          }
        }
      }

      // 8. INSERT CampaignKiosks link — one per unique (kiosk, reservation window).
      // Multiple bookings (display faces) sharing one kiosk string collapse into one link.
      const startKey = toDate(booking.booking_start_date)?.toISOString().slice(0, 10) ?? "null";
      const endKey = toDate(booking.booking_end_date)?.toISOString().slice(0, 10) ?? "null";
      const linkKey = `${display.kiosk}|${startKey}|${endKey}`;

      if (seenLinks.has(linkKey)) {
        stats.campaignKiosksSkippedDuplicates++;
        if (verbose) {
          console.log(
            `    Skipped duplicate CampaignKiosk (same kiosk+window in this run): Campaign ${sqlCampaignId} ↔ Kiosk ${sqlKiosk.id} (ImportKioskID ${display.kiosk}, ${startKey} → ${endKey})`
          );
        }
        continue;
      }

      if (dryRun) {
        seenLinks.add(linkKey);
        stats.campaignKiosksCreated++;
        if (verbose) {
          console.log(
            `    [DRY RUN] Would link CampaignKiosk: Campaign ${sqlCampaignId} ↔ Kiosk ${sqlKiosk.id} (ImportKioskID ${display.kiosk})`
          );
        }
      } else {
        try {
          const campaignKioskRow = mapBookingToCampaignKiosk(booking, sqlCampaignId, sqlKiosk.id);

          // Re-run safety: skip if this exact link already exists in SQL
          if (await campaignKioskLinkExists(pool, campaignKioskRow)) {
            seenLinks.add(linkKey);
            stats.campaignKiosksSkippedDuplicates++;
            if (verbose) {
              console.log(
                `    Skipped existing CampaignKiosk (already in SQL): Campaign ${sqlCampaignId} ↔ Kiosk ${sqlKiosk.id} (ImportKioskID ${display.kiosk}, ${startKey} → ${endKey})`
              );
            }
            continue;
          }

          await insertCampaignKioskRow(pool, campaignKioskRow);
          seenLinks.add(linkKey);
          stats.campaignKiosksCreated++;
          if (verbose) {
            console.log(
              `    Linked CampaignKiosk: Campaign ${sqlCampaignId} ↔ Kiosk ${sqlKiosk.id} (ImportKioskID ${display.kiosk})`
            );
          }
        } catch (insertErr) {
          stats.errors.push(
            `[booking ${bookingRef(booking)}] CampaignKiosks INSERT failed: CampaignID=${sqlCampaignId}, KioskID=${sqlKiosk.id}, ImportKioskID=${display.kiosk} — ${formatMigrationError(insertErr)}`
          );
        }
      }
    }
  } catch (error) {
    stats.ok = false;
    stats.errors.push(`Kiosk migration fatal: ${formatMigrationError(error)}`);
  }

  return stats;
}
