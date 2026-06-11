/**
 * =============================================================================
 * PER-CAMPAIGN display images → Azure Blob (called from bulk campaign migration)
 * =============================================================================
 *
 * After a campaign is migrated to SQL:
 *   1. Mongo bookings for campaign → display ObjectIds (per-campaign scope)
 *   2. Mongo displayimages WHERE display IN those display ids (not all images on kiosk)
 *   3. Resolve import_kiosk_id from kiosks for blob path + InstalledImageUrl
 *   4. Upload to Azure:
 *      {blobPrefix}/{sqlCampaignId}/{import_kiosk_id}/{filename}
 *   5. UPDATE CampaignKiosks.InstalledImageUrl = blob_url
 *      WHERE CampaignID = sqlCampaignId AND KioskID = Kiosks.ID (ImportKioskID)
 *      A kiosk can have MANY displayimages (one per display face / re-install).
 *      Only the LATEST image per kiosk (by mongo `updated`, fallback `created`)
 *      sets InstalledImageUrl — and it overwrites an existing value, so each
 *      CampaignKiosks row always ends up with the most recent install photo.
 *      All images are still uploaded to blob storage; older ones just don't
 *      touch InstalledImageUrl (status: skipped-not-latest).
 *
 * Results per campaign:
 *   display-images-blob-migration/campaign-runs/{sqlCampaignId}/migration_results.csv
 *   display-images-blob-migration/campaign-runs/{sqlCampaignId}/migration_errors.log
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongodb from "mongodb";
import { BlobServiceClient } from "@azure/storage-blob";
import { getMongoConfig } from "../mongo-config.js";
import { sql } from "../sql-connection.js";
import { AZURE_BLOB_CONFIG } from "./blob-storage-config.js";
import {
  createEmptyStats,
  initErrorLogFile,
  printErrorReport,
  processDisplayImageDoc,
  validateAzureConfig,
} from "./migrate-s3-to-azure.js";

const { MongoClient, ObjectId } = mongodb;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CAMPAIGN_RUNS_DIR = path.join(__dirname, "campaign-runs");

const MONGO_BOOKINGS_COLLECTION = "bookings";
const MONGO_DISPLAYS_COLLECTION = "displays";
const MONGO_KIOSKS_COLLECTION = "kiosks";
const MONGO_DISPLAY_IMAGES_COLLECTION = "displayimages";

const SQL_KIOSKS_TABLE = "Kiosks";
const SQL_CAMPAIGN_KIOSKS_TABLE = "CampaignKiosks";

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatMigrationError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  return err.message || String(err);
}

function campaignRunDir(sqlCampaignId) {
  return path.join(CAMPAIGN_RUNS_DIR, String(sqlCampaignId));
}

function campaignOutputPaths(sqlCampaignId) {
  const dir = campaignRunDir(sqlCampaignId);
  return {
    dir,
    resultsCsv: path.join(dir, "migration_results.csv"),
    errorLog: path.join(dir, "migration_errors.log"),
  };
}

/**
 * bookings for campaign → display ObjectIds + ImportKioskID strings from displays.
 * Display images are per campaign via displayimages.display → bookings.display.
 */
async function collectCampaignBookingContext(db, mongoCampaignIdHex) {
  if (!mongoCampaignIdHex) {
    return {
      displayObjectIds: [],
      displayIdHexes: [],
      importKioskIds: [],
      displayKioskMap: new Map(),
    };
  }

  const campaignOid = new ObjectId(mongoCampaignIdHex);
  const bookings = await db
    .collection(MONGO_BOOKINGS_COLLECTION)
    .find({
      $or: [{ campaign: campaignOid }, { campaign: mongoCampaignIdHex }],
    })
    .project({ display: 1 })
    .toArray();

  const displayIdHexes = new Set();
  const importKioskIds = new Set();
  const displayKioskMap = new Map(); // display hex → ImportKioskID string

  for (const booking of bookings) {
    const displayHex = booking.display ? String(booking.display).trim().toLowerCase() : "";
    if (!displayHex) continue;

    displayIdHexes.add(displayHex);

    const display = await db
      .collection(MONGO_DISPLAYS_COLLECTION)
      .findOne({ _id: new ObjectId(displayHex) }, { projection: { kiosk: 1 } });

    const kioskImportId = display?.kiosk ? String(display.kiosk).trim() : "";
    if (kioskImportId) {
      importKioskIds.add(kioskImportId);
      displayKioskMap.set(displayHex, kioskImportId);
    }
  }

  const displayObjectIds = [...displayIdHexes].map((hex) => new ObjectId(hex));
  return {
    displayObjectIds,
    displayIdHexes: [...displayIdHexes],
    importKioskIds: [...importKioskIds],
    displayKioskMap,
  };
}

/**
 * displayimages for this campaign only — match displayimages.display to campaign bookings.
 */
async function fetchDisplayImagesForCampaign(db, mongoCampaignIdHex) {
  const { displayObjectIds, displayIdHexes, importKioskIds, displayKioskMap } =
    await collectCampaignBookingContext(db, mongoCampaignIdHex);

  if (!displayObjectIds.length) {
    return {
      importKioskIds,
      displayIdHexes,
      displayImages: [],
      displayKioskMap,
    };
  }

  const displayImages = await db
    .collection(MONGO_DISPLAY_IMAGES_COLLECTION)
    .find({
      $or: [
        { display: { $in: displayObjectIds } },
        { display: { $in: displayIdHexes } },
      ],
      image_url: { $exists: true, $ne: null, $ne: "" },
    })
    .sort({ created: 1 })
    .toArray();

  return { importKioskIds, displayIdHexes, displayImages, displayKioskMap };
}

/**
 * Pick the LATEST displayimage per kiosk (by mongo `updated`, fallback `created`).
 * Returns a Set of displayimage _id strings that should set InstalledImageUrl.
 * Ties resolve to the later doc in the (created-ascending) list.
 */
function pickLatestImageIdsPerKiosk(displayImages, displayKioskMap) {
  const latestByKiosk = new Map(); // ImportKioskID → { id, ts }

  for (const doc of displayImages) {
    const displayHex = doc.display ? String(doc.display).trim().toLowerCase() : "";
    const importKioskId = displayKioskMap.get(displayHex);
    if (!importKioskId) continue;

    const raw = doc.updated ?? doc.created;
    const ts = raw ? new Date(raw).getTime() || 0 : 0;

    const current = latestByKiosk.get(importKioskId);
    if (!current || ts >= current.ts) {
      latestByKiosk.set(importKioskId, { id: String(doc._id), ts });
    }
  }

  return new Set([...latestByKiosk.values()].map((v) => v.id));
}

async function createContainerClient(azureConfig) {
  const blobService = BlobServiceClient.fromConnectionString(
    azureConfig.connectionString
  );
  const containerClient = blobService.getContainerClient(azureConfig.containerName);

  if (azureConfig.createContainerIfMissing) {
    await containerClient.createIfNotExists();
  } else if (!(await containerClient.exists())) {
    throw new Error(
      `Azure container "${azureConfig.containerName}" does not exist. Create it or set createContainerIfMissing: true`
    );
  }

  return containerClient;
}

async function findSqlKioskIdByImportKioskId(pool, importKioskId) {
  const result = await pool
    .request()
    .input("importKioskId", sql.VarChar(50), importKioskId)
    .query(`
      SELECT TOP 1 ID
      FROM ${SQL_KIOSKS_TABLE}
      WHERE ImportKioskID = @importKioskId
    `);
  if (!result.recordset.length) return null;
  return result.recordset[0].ID;
}

async function findCampaignKiosksForCampaignAndKiosk(pool, sqlCampaignId, sqlKioskId) {
  const result = await pool
    .request()
    .input("campaignId", sql.Int, sqlCampaignId)
    .input("kioskId", sql.Int, sqlKioskId)
    .query(`
      SELECT ID, InstalledImageUrl
      FROM ${SQL_CAMPAIGN_KIOSKS_TABLE}
      WHERE CampaignID = @campaignId AND KioskID = @kioskId
      ORDER BY ID
    `);
  return result.recordset;
}

async function updateCampaignKioskInstalledImageUrl(pool, campaignKioskId, blobUrl) {
  await pool
    .request()
    .input("id", sql.Int, campaignKioskId)
    .input("installedImageUrl", sql.NVarChar(sql.MAX), blobUrl)
    .query(`
      UPDATE ${SQL_CAMPAIGN_KIOSKS_TABLE}
      SET InstalledImageUrl = @installedImageUrl
      WHERE ID = @id
    `);
}

function hasUsableBlobUrl(blobUrl) {
  if (!blobUrl) return false;
  const s = String(blobUrl).trim();
  return s.length > 0 && !s.startsWith("(would upload");
}

/**
 * After blob upload, set CampaignKiosks.InstalledImageUrl for this campaign + kiosk.
 * Only the LATEST image per kiosk (options.isLatestForKiosk) writes the URL,
 * and it OVERWRITES any existing value so re-runs converge to the latest photo.
 */
async function applyInstalledImageUrlForRow(pool, sqlCampaignId, imageRow, options) {
  const dryRun = options.dryRun === true;
  const isLatestForKiosk = options.isLatestForKiosk === true;
  const verbose = options.verbose === true;
  const stats = options.stats;

  const extended = {
    ...imageRow,
    campaignKioskId: "",
    previousInstalledImageUrl: "",
    installedImageUrlStatus: "",
    installedImageUrlError: "",
  };

  if (!isLatestForKiosk) {
    extended.installedImageUrlStatus = "skipped-not-latest";
    if (stats) stats.installedImageUrlSkippedNotLatest++;
    return extended;
  }

  if (!hasUsableBlobUrl(imageRow.blobUrl)) {
    extended.installedImageUrlStatus =
      imageRow.status === "dry-run" ? "dry-run-no-url" : "skipped-no-blob-url";
    return extended;
  }

  if (!["uploaded", "skipped-existing"].includes(imageRow.status)) {
    extended.installedImageUrlStatus = "skipped-image-not-ready";
    return extended;
  }

  if (!pool || sqlCampaignId == null || sqlCampaignId <= 0) {
    extended.installedImageUrlStatus = dryRun
      ? "dry-run-would-update"
      : "skipped-no-sql-campaign-id";
    if (dryRun && stats) stats.installedImageUrlDryRunWouldUpdate++;
    return extended;
  }

  const importKioskId = imageRow.importKioskId;
  if (!importKioskId) {
    extended.installedImageUrlStatus = "skipped-no-import-kiosk-id";
    return extended;
  }

  try {
    const sqlKioskId = await findSqlKioskIdByImportKioskId(pool, importKioskId);
    if (!sqlKioskId) {
      extended.installedImageUrlStatus = "skipped-kiosk-not-found";
      if (stats) stats.installedImageUrlSkippedNoKiosk++;
      return extended;
    }

    const campaignKiosks = await findCampaignKiosksForCampaignAndKiosk(
      pool,
      sqlCampaignId,
      sqlKioskId
    );

    if (!campaignKiosks.length) {
      extended.installedImageUrlStatus = "skipped-no-campaign-kiosk";
      if (stats) stats.installedImageUrlSkippedNoCampaignKiosk++;
      return extended;
    }

    const blobUrl = String(imageRow.blobUrl).trim();
    const updatedIds = [];

    for (const ck of campaignKiosks) {
      const previous = ck.InstalledImageUrl ? String(ck.InstalledImageUrl).trim() : "";

      // Idempotent re-run: already pointing at this exact blob — nothing to do
      if (previous === blobUrl) {
        if (stats) stats.installedImageUrlSkippedExisting++;
        if (verbose) {
          console.log(
            `  [installed-url] skip CampaignKiosks.ID=${ck.ID} (already latest)`
          );
        }
        continue;
      }

      if (dryRun) {
        if (stats) stats.installedImageUrlDryRunWouldUpdate++;
        updatedIds.push(String(ck.ID));
        if (verbose) {
          console.log(
            `  [DRY RUN] Would set InstalledImageUrl on CampaignKiosks.ID=${ck.ID}`
          );
        }
        continue;
      }

      await updateCampaignKioskInstalledImageUrl(pool, ck.ID, blobUrl);
      if (stats) stats.installedImageUrlUpdated++;
      updatedIds.push(String(ck.ID));
      if (verbose) {
        console.log(`  [installed-url] CampaignKiosks.ID=${ck.ID} ← ${blobUrl}`);
      }
    }

    const firstCk = campaignKiosks[0];
    extended.campaignKioskId = updatedIds.join("|") || String(firstCk.ID);
    extended.previousInstalledImageUrl = firstCk.InstalledImageUrl
      ? String(firstCk.InstalledImageUrl)
      : "";

    if (updatedIds.length) {
      extended.installedImageUrlStatus = dryRun ? "dry-run-would-update" : "updated";
    } else if (campaignKiosks.every((ck) => ck.InstalledImageUrl)) {
      extended.installedImageUrlStatus = "skipped-existing";
    } else {
      extended.installedImageUrlStatus = "skipped";
    }

    return extended;
  } catch (err) {
    if (stats) stats.installedImageUrlFailed++;
    extended.installedImageUrlStatus = "error";
    extended.installedImageUrlError = formatMigrationError(err);
    return extended;
  }
}

function writeCampaignImageResultsCsv(filePath, rows) {
  const headers = [
    "display_image_id",
    "sql_campaign_id",
    "kiosk_id",
    "import_kiosk_id",
    "source_image_url",
    "blob_path",
    "blob_url",
    "blob_status",
    "blob_error",
    "campaign_kiosk_id",
    "previous_installed_image_url",
    "installed_image_url_status",
    "installed_image_url_error",
  ];

  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [
        r.displayImageId,
        r.sqlCampaignId ?? "",
        r.kioskHex,
        r.importKioskId,
        r.imageUrl,
        r.blobPath,
        r.blobUrl,
        r.status,
        r.error,
        r.campaignKioskId ?? "",
        r.previousInstalledImageUrl ?? "",
        r.installedImageUrlStatus ?? "",
        r.installedImageUrlError ?? "",
      ]
        .map(escapeCsvCell)
        .join(",")
    ),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

/**
 * Migrate display images for one campaign after SQL Campaign.ID exists.
 *
 * @param {string} mongoCampaignIdHex
 * @param {number} sqlCampaignId - SQL Campaign.ID (folder segment in blob path)
 * @param {{ dryRun?: boolean, skipExisting?: boolean, verbose?: boolean, pool?: object }} options
 */
export async function migrateCampaignDisplayImagesToAzure(
  mongoCampaignIdHex,
  sqlCampaignId,
  options = {}
) {
  const dryRun = options.dryRun === true;
  const skipExisting = options.skipExisting !== false;
  const verbose = options.verbose !== false;
  const pool = options.pool ?? null;
  const azureConfig = AZURE_BLOB_CONFIG;

  const stats = {
    ...createEmptyStats(),
    importKioskIdsFound: 0,
    campaignDisplaysFound: 0,
    displayImagesFound: 0,
    installedImageUrlUpdated: 0,
    installedImageUrlDryRunWouldUpdate: 0,
    installedImageUrlSkippedExisting: 0,
    installedImageUrlSkippedNotLatest: 0,
    installedImageUrlSkippedNoKiosk: 0,
    installedImageUrlSkippedNoCampaignKiosk: 0,
    installedImageUrlFailed: 0,
  };
  const resultRows = [];
  const errors = [];

  const paths = campaignOutputPaths(sqlCampaignId);
  fs.mkdirSync(paths.dir, { recursive: true });
  initErrorLogFile(
    paths.errorLog,
    `Display images — campaign SQL ${sqlCampaignId} mongo ${mongoCampaignIdHex}`
  );

  if (!dryRun) {
    validateAzureConfig(azureConfig);
  }

  const mongoConfig = getMongoConfig();
  const mongoClient = new MongoClient(mongoConfig.uri);

  try {
    await mongoClient.connect();
    const db = mongoClient.db(mongoConfig.dbName);

    const { importKioskIds, displayIdHexes, displayImages, displayKioskMap } =
      await fetchDisplayImagesForCampaign(db, mongoCampaignIdHex);

    stats.importKioskIdsFound = importKioskIds.length;
    stats.campaignDisplaysFound = displayIdHexes.length;
    stats.displayImagesFound = displayImages.length;

    // Latest displayimage per kiosk decides InstalledImageUrl
    const latestImageIds = pickLatestImageIdsPerKiosk(displayImages, displayKioskMap);

    if (verbose) {
      console.log(
        `  [images] displays=${displayIdHexes.length} importKioskIDs=${importKioskIds.length} displayimages=${displayImages.length}`
      );
      if (importKioskIds.length && verbose) {
        console.log(`  [images] ImportKioskIDs: ${importKioskIds.join(", ")}`);
      }
    }

    if (!displayImages.length) {
      writeCampaignImageResultsCsv(paths.resultsCsv, resultRows);
      return {
        ok: true,
        stats,
        resultRows,
        errors,
        outputPath: paths.resultsCsv,
        errorLogPath: paths.errorLog,
      };
    }

    let containerClient = null;
    if (!dryRun) {
      containerClient = await createContainerClient(azureConfig);
    }

    const context = {
      dryRun,
      skipExisting,
      verbose,
      azureConfig,
      db,
      containerClient,
      stats,
      errorLogPath: paths.errorLog,
      sqlCampaignId,
    };

    const total = displayImages.length;
    for (let i = 0; i < displayImages.length; i++) {
      const doc = displayImages[i];
      if (verbose) {
        console.log(`  [images] [${i + 1}/${total}] ${String(doc._id)}`);
      }
      const imageRow = await processDisplayImageDoc(doc, context);
      const row = await applyInstalledImageUrlForRow(pool, sqlCampaignId, imageRow, {
        dryRun,
        verbose,
        stats,
        isLatestForKiosk: latestImageIds.has(String(doc._id)),
      });
      resultRows.push(row);
    }

    writeCampaignImageResultsCsv(paths.resultsCsv, resultRows);
    printErrorReport(resultRows, paths.errorLog);

    const ok = stats.failed === 0 && stats.installedImageUrlFailed === 0;
    return {
      ok,
      stats,
      resultRows,
      errors,
      outputPath: paths.resultsCsv,
      errorLogPath: paths.errorLog,
    };
  } catch (err) {
    const msg = formatMigrationError(err);
    errors.push(msg);
    return {
      ok: false,
      stats,
      resultRows,
      errors,
      outputPath: paths.resultsCsv,
      errorLogPath: paths.errorLog,
      error: msg,
    };
  } finally {
    await mongoClient.close();
  }
}
