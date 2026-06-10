#!/usr/bin/env node
/**
 * =============================================================================
 * FETCH display images by Mongo campaign ID (Terraboost admin API)
 * =============================================================================
 *
 * Input:  campaigns_ids_result.csv  (_id column = Mongo campaign ObjectId)
 * API:    GET {API_BASE_URL}/{mongoCampaignId}
 * Output: display_images_by_campaign.csv
 *         fetch_summary.csv (per campaign)
 *         fetch_errors.log
 *
 * Auth: hardcoded in fetch-config.js getAdminCookie()
 *
 * RUN:
 *   npm run fetch:display-images-by-campaign:dry-run:limit1
 *   npm run fetch:display-images-by-campaign:limit1
 *   npm run fetch:display-images-by-campaign
 *
 * FLAGS:
 *   --dry-run       List campaign IDs only — no HTTP
 *   --limit N       First N campaign IDs from CSV
 *   --input path    Input CSV (default: campaigns_ids_result.csv)
 *   --output path   Output CSV (default: display_images_by_campaign.csv)
 *   --cookie '...'  Admin cookie header value (overrides fetch-config.js)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getArg, parseCampaignIdsFromCsv, writeCsv } from "../csv-utils.js";
import {
  API_BASE_URL,
  REQUEST_DELAY_MS,
  REQUEST_TIMEOUT_MS,
  getAdminCookie,
} from "./fetch-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const DEFAULT_INPUT = path.join(ROOT, "campaigns_ids_result.csv");
const DEFAULT_OUTPUT = path.join(__dirname, "display_images_by_campaign.csv");
const DEFAULT_SUMMARY = path.join(__dirname, "fetch_summary.csv");
const DEFAULT_ERROR_LOG = path.join(__dirname, "fetch_errors.log");

const CAMPAIGN_ID_COLUMN = "campaign_id";

const KNOWN_IMAGE_KEYS = [
  "_id",
  "created",
  "id",
  "meta",
  "updated",
  "image_url",
  "kiosk",
  "display",
  "venue",
  "verfied",
  "verified",
];

function getCliFlag(argv, flag) {
  return argv.includes(flag);
}

function parseCli(argv) {
  const limitRaw = getArg(argv, "--limit");
  const limit = limitRaw != null ? parseInt(limitRaw, 10) : null;

  return {
    dryRun: getCliFlag(argv, "--dry-run"),
    limit: Number.isFinite(limit) && limit > 0 ? limit : null,
    inputPath: getArg(argv, "--input") || DEFAULT_INPUT,
    outputPath: getArg(argv, "--output") || DEFAULT_OUTPUT,
    summaryPath: getArg(argv, "--summary") || DEFAULT_SUMMARY,
    errorLogPath: getArg(argv, "--error-log") || DEFAULT_ERROR_LOG,
    cookie: getArg(argv, "--cookie"),
    delayMs: Number(getArg(argv, "--delay")) || REQUEST_DELAY_MS,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeApiValue(value) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function imageObjectToRow(campaignId, item) {
  const row = { [CAMPAIGN_ID_COLUMN]: campaignId };
  for (const [key, value] of Object.entries(item)) {
    row[key] = serializeApiValue(value);
  }
  return row;
}

function buildCsvHeaders(rows) {
  const keySet = new Set([CAMPAIGN_ID_COLUMN]);
  for (const key of KNOWN_IMAGE_KEYS) keySet.add(key);
  for (const row of rows) {
    for (const key of Object.keys(row)) keySet.add(key);
  }

  const ordered = [CAMPAIGN_ID_COLUMN];
  for (const key of KNOWN_IMAGE_KEYS) {
    if (keySet.has(key) && key !== CAMPAIGN_ID_COLUMN) {
      ordered.push(key);
      keySet.delete(key);
    }
  }
  for (const key of [...keySet].sort()) {
    if (key !== CAMPAIGN_ID_COLUMN) ordered.push(key);
  }
  return ordered;
}

function initErrorLog(errorLogPath) {
  fs.writeFileSync(
    errorLogPath,
    `=== Fetch display images by campaign — ${new Date().toISOString()} ===\n\n`,
    "utf8"
  );
}

function appendErrorLog(errorLogPath, message) {
  fs.appendFileSync(errorLogPath, `${message}\n`, "utf8");
}

function resolveCookie(cliCookie) {
  if (cliCookie) return cliCookie.trim();
  return getAdminCookie();
}

async function fetchDisplayImagesForCampaign(campaignId, cookie) {
  const url = `${API_BASE_URL}/${campaignId}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${campaignId}: ${text.slice(0, 300)}`);
  }

  let data;
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    throw new Error(`Invalid JSON for ${campaignId}: ${text.slice(0, 300)}`);
  }

  if (!Array.isArray(data)) {
    throw new Error(`Expected JSON array for ${campaignId}, got ${typeof data}`);
  }

  return data;
}

export async function fetchDisplayImagesByCampaign(options) {
  const {
    dryRun,
    limit,
    inputPath,
    outputPath,
    summaryPath,
    errorLogPath,
    cookie: cliCookie,
    delayMs,
  } = options;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input CSV not found: ${inputPath}`);
  }

  let campaignIds = parseCampaignIdsFromCsv(fs.readFileSync(inputPath, "utf8"));
  if (!campaignIds.length) {
    throw new Error("No valid campaign ObjectIds in input CSV.");
  }
  if (limit) campaignIds = campaignIds.slice(0, limit);

  initErrorLog(errorLogPath);

  if (dryRun) {
    console.log(`[DRY RUN] Would fetch ${campaignIds.length} campaign(s)`);
    for (let i = 0; i < campaignIds.length; i++) {
      console.log(`  [${i + 1}/${campaignIds.length}] ${campaignIds[i]}`);
    }
    return { ok: true, campaignCount: campaignIds.length, imageRowCount: 0, dryRun: true };
  }

  const cookie = resolveCookie(cliCookie);
  if (!cookie) {
    throw new Error("Admin cookie is empty. Set getAdminCookie() in fetch-config.js");
  }

  const imageRows = [];
  const summaryRows = [];
  let okCount = 0;
  let failCount = 0;

  console.log(`Fetching display images for ${campaignIds.length} campaign(s)...\n`);

  for (let i = 0; i < campaignIds.length; i++) {
    const campaignId = campaignIds[i];
    const prefix = `[${i + 1}/${campaignIds.length}]`;

    try {
      const items = await fetchDisplayImagesForCampaign(campaignId, cookie);
      console.log(`${prefix} ${campaignId} → ${items.length} image(s)`);

      for (const item of items) {
        imageRows.push(imageObjectToRow(campaignId, item));
      }

      summaryRows.push({
        campaign_id: campaignId,
        status: "ok",
        image_count: String(items.length),
        error: "",
      });
      okCount++;
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`${prefix} ${campaignId} → ERROR: ${msg}`);
      appendErrorLog(errorLogPath, `[ERROR] ${campaignId}: ${msg}`);
      summaryRows.push({
        campaign_id: campaignId,
        status: "error",
        image_count: "0",
        error: msg,
      });
      failCount++;
    }

    if (i + 1 < campaignIds.length && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const headers = buildCsvHeaders(imageRows);
  writeCsv(outputPath, headers, imageRows);
  writeCsv(summaryPath, ["campaign_id", "status", "image_count", "error"], summaryRows);

  console.log("\n" + "=".repeat(60));
  console.log("FETCH DISPLAY IMAGES — SUMMARY");
  console.log("=".repeat(60));
  console.log(`  Campaigns requested:  ${campaignIds.length}`);
  console.log(`  Campaigns ok:         ${okCount}`);
  console.log(`  Campaigns failed:     ${failCount}`);
  console.log(`  Image rows written:   ${imageRows.length}`);
  console.log(`  Output CSV:           ${outputPath}`);
  console.log(`  Summary CSV:          ${summaryPath}`);
  console.log(`  Error log:            ${errorLogPath}`);

  return {
    ok: failCount === 0,
    campaignCount: campaignIds.length,
    imageRowCount: imageRows.length,
    okCount,
    failCount,
  };
}

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

  console.log("Fetch display images by campaign (Terraboost admin API)");
  console.log(`  Input:    ${options.inputPath}`);
  console.log(`  Output:   ${options.outputPath}`);
  console.log(`  Dry run:  ${options.dryRun ? "yes" : "no"}`);
  console.log(`  Limit:    ${options.limit ?? "none"}`);
  console.log(`  Delay:    ${options.delayMs}ms between requests\n`);

  fetchDisplayImagesByCampaign(options)
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err) => {
      console.error("Fatal:", err.message || err);
      if (err.stack) console.error(err.stack);
      process.exit(1);
    });
}
