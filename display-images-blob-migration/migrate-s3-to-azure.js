#!/usr/bin/env node
/**
 * =============================================================================
 * DISPLAY IMAGES — S3 (Mongo image_url) → Azure Blob Storage
 * =============================================================================
 *
 * Reads Mongo displayimages, resolves import_kiosk_id from kiosks collection,
 * downloads each image from S3, uploads to Azure Blob.
 *
 * Blob path format (bulk — no campaign folder):
 *   {blobPrefix}/{import_kiosk_id}/{filename}
 *   e.g. mongo_installed_image_url/10006A/display-image-1486679320780
 *
 * Per-campaign (from bulk CSV orchestrator):
 *   {blobPrefix}/{sqlCampaignId}/{import_kiosk_id}/{filename}
 *   see migrate-campaign-display-images-to-azure.js
 *   (filename from S3 URL pathname — no extension added by this script)
 *
 * Mongo collections (mydb):
 *   - displayimages  → image_url, kiosk (ObjectId)
 *   - kiosks         → _id, import_kiosk_id
 *
 * Requires Node 20+ (native fetch).
 *
 * BULK (all rows, optional limit):
 *   npm run migrate:display-images-to-azure
 *   npm run migrate:display-images-to-azure:dry-run
 *   npm run migrate:display-images-to-azure:dry-run:limit5
 *
 * FLAGS:
 *   --dry-run              Preview only — no download/upload (Azure config not required)
 *   --limit N              Process at most N rows
 *   --force                Re-upload even if blob already exists (default: skip existing)
 *   --output path.csv      Results CSV path
 *   --error-log path.log   Error detail log (default: migration_errors.log)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongodb from "mongodb";
import { BlobServiceClient } from "@azure/storage-blob";
import { getMongoConfig } from "../mongo-config.js";
import { AZURE_BLOB_CONFIG } from "./blob-storage-config.js";
import { getArg } from "../csv-utils.js";

/** Set true to default to dry-run when CLI does not pass --dry-run */
const DRY_RUN_DEFAULT = false;

/** Skip Azure upload when blob path already exists. Use --force to re-upload. */
const SKIP_EXISTING_DEFAULT = true;

const { MongoClient, ObjectId } = mongodb;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// MONGO COLLECTION NAMES
// =============================================================================

const MONGO_DISPLAY_IMAGES_COLLECTION = "displayimages";
const MONGO_KIOSKS_COLLECTION = "kiosks";

const DEFAULT_RESULTS_CSV = path.join(__dirname, "migration_results.csv");
const DEFAULT_ERROR_LOG = path.join(__dirname, "migration_errors.log");

// =============================================================================
// CLI
// =============================================================================

function getCliFlag(argv, flag) {
  return argv.includes(flag);
}

function parseCli(argv) {
  const limitRaw = getArg(argv, "--limit");
  const limit = limitRaw != null ? parseInt(limitRaw, 10) : null;
  const dryRun = getCliFlag(argv, "--dry-run") || DRY_RUN_DEFAULT;
  const skipExisting = getCliFlag(argv, "--force")
    ? false
    : SKIP_EXISTING_DEFAULT;

  return {
    dryRun,
    skipExisting,
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    verbose: getCliFlag(argv, "--verbose"),
    outputPath: getArg(argv, "--output") || DEFAULT_RESULTS_CSV,
    errorLogPath: getArg(argv, "--error-log") || DEFAULT_ERROR_LOG,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function filenameFromImageUrl(imageUrl) {
  try {
    const pathname = new URL(imageUrl).pathname;
    const base = path.basename(pathname);
    return base && base !== "/" ? decodeURIComponent(base) : null;
  } catch {
    return null;
  }
}

/** Blob filename = S3 URL pathname only (no extension added by migration code). */
function blobFilenameFromUrl(imageUrl, fallbackId) {
  const fromUrl = filenameFromImageUrl(imageUrl);
  if (fromUrl) return fromUrl;
  return fallbackId ? `display-image-${fallbackId}` : `display-image-${Date.now()}`;
}

function buildBlobPath(blobPrefix, importKioskId, filename, sqlCampaignId = null) {
  const safeKioskId = String(importKioskId).trim().replace(/[/\\]/g, "-");
  const safeFilename = path.basename(filename);
  const campaignSegment =
    sqlCampaignId != null && String(sqlCampaignId).trim() !== ""
      ? `${String(sqlCampaignId).trim()}/`
      : "";
  return `${blobPrefix}/${campaignSegment}${safeKioskId}/${safeFilename}`;
}

function trimConfigValue(value) {
  return value != null ? String(value).trim() : "";
}

function formatMigrationError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  const parts = [err.message || String(err)];
  if (err.statusCode != null) parts.push(`HTTP ${err.statusCode}`);
  if (err.code) parts.push(`code ${err.code}`);
  if (err.number != null) parts.push(`SQL ${err.number}`);
  return parts.join(" | ");
}

/** Console + optional file log for failed or skipped rows. */
function logMigrationIssue(row, err, errorLogPath, options = {}) {
  const level = options.level || (row.status === "error" ? "error" : "warn");
  const msg = err ? formatMigrationError(err) : row.error || "unknown issue";
  const lines = [
    `  [${level.toUpperCase()}] displayimages._id=${row.displayImageId}`,
    `          status=${row.status}`,
    `          kiosk=${row.kioskHex || "n/a"} import_kiosk_id=${row.importKioskId || "n/a"}`,
    `          image_url=${row.imageUrl || "n/a"}`,
    `          blob_path=${row.blobPath || "n/a"}`,
    `          message=${msg}`,
  ];

  if (level === "error") {
    console.error(lines.join("\n"));
    if (err?.stack) console.error(err.stack);
  } else {
    console.warn(lines.join("\n"));
  }

  if (errorLogPath) {
    appendErrorLogFile(errorLogPath, row, msg);
  }
}

export function initErrorLogFile(errorLogPath, title) {
  const header = [
    `=== ${title || "Display images migration (bulk)"} — ${new Date().toISOString()} ===`,
    "",
  ].join("\n");
  fs.writeFileSync(errorLogPath, `${header}\n`, "utf8");
}

function appendErrorLogFile(errorLogPath, row, message) {
  const block = [
    `[${new Date().toISOString()}] display_image_id=${row.displayImageId} status=${row.status}`,
    `  kiosk=${row.kioskHex || ""} import_kiosk_id=${row.importKioskId || ""}`,
    `  image_url=${row.imageUrl || ""}`,
    `  blob_path=${row.blobPath || ""}`,
    `  error=${message}`,
    "",
  ].join("\n");
  fs.appendFileSync(errorLogPath, block, "utf8");
}

export function printErrorReport(resultRows, errorLogPath) {
  const issues = resultRows.filter(
    (r) => r.status === "error" || (r.status === "skipped" && r.error)
  );
  if (!issues.length) return;

  console.log("\n[Errors / skipped issues]");
  for (let i = 0; i < issues.length; i++) {
    const r = issues[i];
    console.log(
      `  ${i + 1}. ${r.displayImageId} (${r.status}) — ${r.error || "n/a"}`
    );
  }
  if (errorLogPath) {
    console.log(`  Full detail: ${errorLogPath}`);
  }
}

export function validateAzureConfig(config) {
  if (!trimConfigValue(config.connectionString)) {
    throw new Error(
      "Azure connection string is empty. Set AZURE_BLOB_CONFIG.connectionString in blob-storage-config.js"
    );
  }
  if (!trimConfigValue(config.containerName)) {
    throw new Error("Azure containerName is empty in blob-storage-config.js");
  }
  if (!trimConfigValue(config.blobPrefix)) {
    throw new Error("Azure blobPrefix is empty in blob-storage-config.js");
  }
}

export function createEmptyStats() {
  return {
    processed: 0,
    uploaded: 0,
    skippedExisting: 0,
    skippedNoKiosk: 0,
    skippedNoUrl: 0,
    skippedNoImportId: 0,
    dryRunWouldUpload: 0,
    failed: 0,
  };
}

function logDryRunPreview(doc, row, verbose) {
  if (!verbose) {
    console.log(`  [DRY RUN] ${row.displayImageId} → ${row.blobPath}`);
    return;
  }

  console.log(`  [DRY RUN] displayimages._id: ${row.displayImageId}`);
  console.log(`    source image_url:  ${row.imageUrl}`);
  console.log(`    kiosk ObjectId:    ${row.kioskHex}`);
  console.log(`    import_kiosk_id:   ${row.importKioskId}`);
  console.log(`    blob path:         ${row.blobPath}`);
  if (doc.meta) console.log(`    meta:              ${doc.meta}`);
  if (doc.verified != null) console.log(`    verified:          ${doc.verified}`);
}

// =============================================================================
// MONGO
// =============================================================================

/** displayimages.kiosk → 24-char hex (ObjectId or string). */
function kioskRefToHex(kioskField) {
  if (kioskField == null) return "";
  if (kioskField instanceof ObjectId) return String(kioskField).toLowerCase();
  const hex = String(kioskField).trim().toLowerCase();
  return /^[a-f0-9]{24}$/.test(hex) ? hex : "";
}

/** Read import_kiosk_id from a kiosks collection document. */
function readImportKioskId(kioskDoc) {
  if (!kioskDoc || kioskDoc.import_kiosk_id == null) return "";
  return String(kioskDoc.import_kiosk_id).trim();
}

/**
 * Per row: displayimages.kiosk → kiosks.findOne → import_kiosk_id (no bulk preload).
 */
async function resolveImportKioskId(db, kioskField) {
  const kioskHex = kioskRefToHex(kioskField);
  if (!kioskHex) {
    return {
      kioskHex: "",
      importKioskId: null,
      error: "invalid or missing kiosk ObjectId on displayimages row",
    };
  }

  const doc = await db.collection(MONGO_KIOSKS_COLLECTION).findOne(
    { _id: new ObjectId(kioskHex) },
    { projection: { import_kiosk_id: 1 } }
  );

  if (!doc) {
    return {
      kioskHex,
      importKioskId: null,
      error: `kiosk ${kioskHex} not found in Mongo "${MONGO_KIOSKS_COLLECTION}"`,
    };
  }

  const importKioskId = readImportKioskId(doc);
  if (!importKioskId) {
    return {
      kioskHex,
      importKioskId: null,
      error: `kiosk ${kioskHex} found in "${MONGO_KIOSKS_COLLECTION}" but import_kiosk_id is empty`,
    };
  }

  return { kioskHex, importKioskId, error: null };
}

async function fetchDisplayImages(db, limit) {
  const query = {
    image_url: { $exists: true, $ne: null, $ne: "" },
    kiosk: { $exists: true, $ne: null },
  };

  let cursor = db
    .collection(MONGO_DISPLAY_IMAGES_COLLECTION)
    .find(query)
    .sort({ created: 1 });

  if (limit) cursor = cursor.limit(limit);

  return cursor.toArray();
}

// =============================================================================
// DOWNLOAD / UPLOAD
// =============================================================================

async function downloadImage(imageUrl) {
  const response = await fetch(imageUrl, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} downloading ${imageUrl}`);
  }

  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!buffer.length) {
    throw new Error(`Empty response body from ${imageUrl}`);
  }

  return { buffer, contentType };
}

async function blobExists(containerClient, blobPath) {
  const client = containerClient.getBlockBlobClient(blobPath);
  return client.exists();
}

async function uploadToAzure(containerClient, blobPath, buffer, contentType) {
  const client = containerClient.getBlockBlobClient(blobPath);
  await client.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return client.url;
}

// =============================================================================
// PER-ROW PROCESSING
// =============================================================================

/**
 * Process one displayImages document → download S3, upload Azure (or dry-run preview).
 */
export async function processDisplayImageDoc(doc, context) {
  const {
    dryRun,
    skipExisting,
    verbose,
    azureConfig,
    db,
    containerClient,
    stats,
    errorLogPath,
    sqlCampaignId = null,
  } = context;

  stats.processed++;

  const displayImageId = String(doc._id);
  const imageUrl = doc.image_url ? String(doc.image_url).trim() : "";
  const kioskHexPreview = kioskRefToHex(doc.kiosk);

  const baseRow = {
    displayImageId,
    sqlCampaignId: sqlCampaignId != null ? String(sqlCampaignId) : "",
    kioskHex: kioskHexPreview,
    imageUrl,
    importKioskId: "",
    blobPath: "",
    blobUrl: "",
    status: "",
    error: "",
  };

  if (!imageUrl) {
    stats.skippedNoUrl++;
    const row = { ...baseRow, status: "skipped", error: "missing image_url" };
    logMigrationIssue(row, null, errorLogPath, { level: "warn" });
    return row;
  }

  if (!kioskHexPreview) {
    stats.skippedNoKiosk++;
    const row = {
      ...baseRow,
      status: "skipped",
      error: "missing or invalid kiosk reference",
    };
    logMigrationIssue(row, null, errorLogPath, { level: "warn" });
    return row;
  }

  const resolved = await resolveImportKioskId(db, doc.kiosk);
  baseRow.kioskHex = resolved.kioskHex || kioskHexPreview;

  if (!resolved.importKioskId) {
    stats.skippedNoImportId++;
    const row = {
      ...baseRow,
      status: "skipped",
      error: resolved.error || `no import_kiosk_id for kiosk ${baseRow.kioskHex}`,
    };
    logMigrationIssue(row, null, errorLogPath, { level: "warn" });
    return row;
  }

  const importKioskId = resolved.importKioskId;

  const blobFilename = blobFilenameFromUrl(imageUrl, displayImageId);
  const blobPath = buildBlobPath(
    azureConfig.blobPrefix,
    importKioskId,
    blobFilename,
    sqlCampaignId
  );

  baseRow.importKioskId = importKioskId;
  baseRow.blobPath = blobPath;

  if (dryRun) {
    stats.dryRunWouldUpload++;
    logDryRunPreview(doc, baseRow, verbose);
    return {
      ...baseRow,
      status: "dry-run",
      blobUrl: `(would upload to ${blobPath})`,
    };
  }

  try {
    if (skipExisting && (await blobExists(containerClient, blobPath))) {
      stats.skippedExisting++;
      const blobUrl = containerClient.getBlockBlobClient(blobPath).url;
      console.log(`  [skip] ${blobPath} (already exists)`);
      return { ...baseRow, status: "skipped-existing", blobUrl };
    }

    const { buffer, contentType } = await downloadImage(imageUrl);

    const blobUrl = await uploadToAzure(
      containerClient,
      blobPath,
      buffer,
      contentType
    );

    stats.uploaded++;
    console.log(`  [ok] ${displayImageId} → ${blobPath}`);
    return { ...baseRow, status: "uploaded", blobUrl };
  } catch (err) {
    stats.failed++;
    const row = {
      ...baseRow,
      status: "error",
      error: formatMigrationError(err),
    };
    logMigrationIssue(row, err, errorLogPath, { level: "error" });
    return row;
  }
}

// =============================================================================
// MAIN — bulk
// =============================================================================

/**
 * Bulk display image migration: Mongo displayimages → Azure Blob.
 */
export async function migrateDisplayImages(options) {
  const {
    dryRun,
    skipExisting,
    limit,
    verbose,
    outputPath,
    errorLogPath = DEFAULT_ERROR_LOG,
  } = options;

  const azureConfig = AZURE_BLOB_CONFIG;

  if (!dryRun) {
    validateAzureConfig(azureConfig);
  }

  const mongoConfig = getMongoConfig();
  const mongoClient = new MongoClient(mongoConfig.uri);
  const stats = createEmptyStats();
  const resultRows = [];

  try {
    await mongoClient.connect();
    const db = mongoClient.db(mongoConfig.dbName);

    console.log(`Querying ${MONGO_DISPLAY_IMAGES_COLLECTION}...`);
    const displayImages = await fetchDisplayImages(db, limit);

    initErrorLogFile(errorLogPath);

    if (!displayImages.length) {
      writeResultsCsv(outputPath, resultRows);
      printSummary(stats, dryRun, outputPath, azureConfig, { errorLogPath });
      return { ok: true, stats, resultRows };
    }

    console.log(
      `  ${displayImages.length} display image row(s) to process (kiosk lookup per row in "${MONGO_KIOSKS_COLLECTION}")\n`
    );

    let containerClient = null;
    if (!dryRun) {
      const blobService = BlobServiceClient.fromConnectionString(
        azureConfig.connectionString
      );
      containerClient = blobService.getContainerClient(azureConfig.containerName);

      if (azureConfig.createContainerIfMissing) {
        await containerClient.createIfNotExists();
      } else if (!(await containerClient.exists())) {
        throw new Error(
          `Azure container "${azureConfig.containerName}" does not exist. Create it or set createContainerIfMissing: true`
        );
      }
    }

    const context = {
      dryRun,
      skipExisting,
      verbose,
      azureConfig,
      db,
      containerClient,
      stats,
      errorLogPath,
    };

    const total = displayImages.length;
    for (let i = 0; i < displayImages.length; i++) {
      const doc = displayImages[i];
      console.log(`[${i + 1}/${total}] ${String(doc._id)}`);
      const row = await processDisplayImageDoc(doc, context);
      resultRows.push(row);
    }

    writeResultsCsv(outputPath, resultRows);
    printSummary(stats, dryRun, outputPath, azureConfig, { errorLogPath });
    printErrorReport(resultRows, errorLogPath);

    const ok = stats.failed === 0;
    return { ok, stats, resultRows };
  } finally {
    await mongoClient.close();
  }
}

export function writeResultsCsv(outputPath, rows) {
  const header = [
    "display_image_id",
    "sql_campaign_id",
    "kiosk_id",
    "import_kiosk_id",
    "source_image_url",
    "blob_path",
    "blob_url",
    "status",
    "error",
  ].join(",");

  const lines = rows.map((r) =>
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
    ]
      .map(escapeCsvCell)
      .join(",")
  );

  fs.writeFileSync(outputPath, `${header}\n${lines.join("\n")}\n`, "utf8");
}

function printSummary(stats, dryRun, outputPath, azureConfig, mode) {
  console.log("\n" + "=".repeat(60));
  console.log("DISPLAY IMAGES (BULK) → AZURE BLOB — SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Dry run:              ${dryRun ? "yes" : "no"}`);
  console.log(`  Blob prefix:          ${azureConfig.blobPrefix}`);
  console.log(`  Container:            ${azureConfig.containerName || "(not set)"}`);
  console.log(`  Processed:            ${stats.processed}`);
  console.log(`  Uploaded:             ${stats.uploaded}`);
  console.log(`  Dry-run would upload: ${stats.dryRunWouldUpload}`);
  console.log(`  Skipped (exists):     ${stats.skippedExisting}`);
  console.log(`  Skipped (no URL):     ${stats.skippedNoUrl}`);
  console.log(`  Skipped (no kiosk):   ${stats.skippedNoKiosk}`);
  console.log(`  Skipped (no import):  ${stats.skippedNoImportId}`);
  console.log(`  Failed:               ${stats.failed}`);
  console.log(`  Results CSV:          ${outputPath}`);
  if (mode?.errorLogPath) {
    console.log(`  Error log:            ${mode.errorLogPath}`);
  }
}

// =============================================================================
// ENTRY — direct CLI only
// =============================================================================

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  let options;
  try {
    options = parseCli(process.argv);
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }

  console.log("Display images: S3 → Azure Blob (bulk)");
  console.log(`  Dry run:        ${options.dryRun ? "yes" : "no"}`);
  console.log(
    `  Skip existing:  ${options.skipExisting ? "yes (use --force to re-upload)" : "no (--force)"}`
  );
  console.log(`  Limit:          ${options.limit ?? "none"}`);
  console.log(`  Output CSV:     ${options.outputPath}`);
  console.log(`  Error log:      ${options.errorLogPath}\n`);

  migrateDisplayImages(options)
    .then((result) => {
      if (!result.ok) {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error("Fatal:", err.message || err);
      if (err.stack) console.error(err.stack);
      process.exit(1);
    });
}
