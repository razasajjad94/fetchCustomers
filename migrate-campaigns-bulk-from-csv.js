#!/usr/bin/env node
/**
 * =============================================================================
 * BULK CAMPAIGN MIGRATION — Mongo campaigns → SQL Server v3 (from CSV)
 * =============================================================================
 *
 * WHAT THIS FILE DOES (only bulk orchestration lives here):
 *   1. Read a CSV of Mongo campaign ObjectIds (_id / campaign_id column)
 *   2. Open ONE SQL connection and load STATUSES once (shared for all rows)
 *   3. For each campaign id, call migrateOneCampaign() from migrate-single-campaign-mongo-to-sql-v3.js
 *      (same mapping/insert logic as single-campaign script — customer, sales rep, OrderNumber, etc.)
 *   4. Write migration_bulk_results.csv with ok/error per row
 *
 * WHAT THIS FILE DOES NOT CONTAIN:
 *   Field mapping, SQL INSERTs, and deduplication rules are all in:
 *   migrate-single-campaign-mongo-to-sql-v3.js
 *   SQL connection: SQL_V3_CONNECTION_STRING in BULK CONFIG below (separate from single script).
 *   Field mapping / CREATE_* flags: migrate-single-campaign-mongo-to-sql-v3.js
 *
 * PIPELINE (typical):
 *   EmailsResult.csv
 *     → fetch-customer-ids-from-emails.js → customer_ids_from_emails.csv
 *     → fetch-campaign-ids-from-customers.js → campaign_ids_from_customers.csv
 *     → THIS SCRIPT → migration_bulk_results.csv
 *
 * ASSUMPTIONS:
 *   - Each CSV row is a 24-char Mongo campaigns._id hex string
 *   - Re-running creates NEW Campaign rows (no upsert by mongo id)
 *   - Users / CustomerLogins reused by email across rows (no duplicate create)
 *   - Default: continue batch on error; use --stop-on-error to abort
 *
 * RUN (package.json scripts):
 *   npm run migrate:campaigns-bulk-from-csv              # full CSV, writes SQL
 *   npm run migrate:campaigns-bulk-from-csv:dry-run      # preview, no writes
 *   npm run migrate:campaigns-bulk-from-csv:dry-run:limit5
 *   npm run migrate:campaigns-bulk-from-csv:limit5       # first 5 rows, writes SQL
 *   npm run migrate:campaigns-bulk-from-csv:stop-on-error
 *   Extra flags: npm run migrate:campaigns-bulk-from-csv -- --input path.csv --limit 10
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getArg, parseCampaignIdsFromCsv, escapeCsvCell } from "./csv-utils.js";
import {
  createMigrationContext,
  migrateOneCampaign,
} from "./migrate-single-campaign-mongo-to-sql-v3.js";
import { migrateCampaignKiosks } from "./migrate-campaign-kiosks.js";
import { migrateCampaignPaymentSchedules } from "./migrate-campaign-payment-schedules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// =============================================================================
// BULK CONFIG — edit these for batch runs
// =============================================================================

// SQL Server v3 connection (bulk only — keep in sync with single script if needed)
const SQL_V3_CONNECTION_STRING =
  "Server=20.118.225.243,1433;Database=TB-V1Migrate;User Id=TBProdDBO;Password=TerraB00st2025DBO!;Encrypt=True;TrustServerCertificate=True;MultipleActiveResultSets=True;Connection Timeout=30;";

/**
 * Default input CSV (first file that exists wins):
 * - campaign_ids_from_customers.csv — new pipeline output
 * - campaigns_ids_result.csv — legacy name on disk
 */
function resolveDefaultInputPath() {
  const candidates = ["campaign_ids_from_customers.csv", "campaigns_ids_result.csv"];
  for (const name of candidates) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) return full;
  }
  return path.join(__dirname, "campaign_ids_from_customers.csv");
}

/** One result row per campaign processed */
const DEFAULT_OUTPUT = path.join(__dirname, "migration_bulk_results.csv");

/** true = no SQL writes for any campaign (preview only) */
const DRY_RUN = false;

/** true = stop loop on first failed campaign; false = log error and continue */
const STOP_ON_ERROR = false;

// =============================================================================
// CLI helpers
// =============================================================================

function getCliFlag(argv, flag) {
  return argv.includes(flag);
}

/** Database + server from SQL_V3_CONNECTION_STRING (no password). */
function formatSqlTarget(connectionString) {
  const database = connectionString.match(/Database=([^;]+)/i)?.[1] ?? "(unknown)";
  const server = connectionString.match(/Server=([^;]+)/i)?.[1] ?? "(unknown)";
  return `${database} @ ${server}`;
}

/** Print kiosk step summary and every warning/error for one campaign. */
function logKioskIssues(logPrefix, mongoCampaignId, sqlCampaignId, kioskStats) {
  if (!kioskStats) return;

  const bookings = kioskStats.bookingsProcessed ?? 0;
  const linked = kioskStats.campaignKiosksCreated ?? 0;
  const errs = kioskStats.errors ?? [];

  if (bookings === 0 && errs.length === 0) {
    console.log(`${logPrefix}  [kiosks] no bookings in Mongo for this campaign`);
    return;
  }

  console.log(
    `${logPrefix}  [kiosks] bookings=${bookings} linked=${linked} created=${kioskStats.kiosksCreated ?? 0} reused=${kioskStats.kiosksReused ?? 0} venues+${kioskStats.venuesCreated ?? 0} venues↺${kioskStats.venuesReused ?? 0}`
  );

  if (errs.length === 0) return;

  console.warn(
    `${logPrefix}  [kiosks] ${errs.length} warning(s) — campaign ${mongoCampaignId}${sqlCampaignId != null && sqlCampaignId > 0 ? ` → SQL Campaign.ID ${sqlCampaignId}` : ""}:`
  );
  for (let i = 0; i < errs.length; i++) {
    console.warn(`${logPrefix}    ${i + 1}. ${errs[i]}`);
  }
}

/** Print payment schedule step summary and warnings. */
function logPaymentIssues(logPrefix, mongoCampaignId, sqlCampaignId, paymentStats) {
  if (!paymentStats) return;

  const n = paymentStats.schedulesProcessed ?? 0;
  const errs = paymentStats.errors ?? [];

  if (n === 0 && errs.length === 0) {
    console.log(`${logPrefix}  [payments] no paymentschedules in Mongo for this campaign`);
    return;
  }

  console.log(
    `${logPrefix}  [payments] schedules=${n} invoiceHeaders=${paymentStats.invoiceHeadersCreated ?? 0} paymentSchedules=${paymentStats.paymentSchedulesCreated ?? 0}`
  );

  if (errs.length === 0) return;

  console.warn(
    `${logPrefix}  [payments] ${errs.length} warning(s) — campaign ${mongoCampaignId}${sqlCampaignId != null && sqlCampaignId > 0 ? ` → SQL Campaign.ID ${sqlCampaignId}` : ""}:`
  );
  for (let i = 0; i < errs.length; i++) {
    console.warn(`${logPrefix}    ${i + 1}. ${errs[i]}`);
  }
}

// =============================================================================
// Output CSV — one line per campaign after migrateOneCampaign() returns
// =============================================================================

/**
 * Build one results CSV row from migrateOneCampaign() return value.
 * Columns match header written in main().
 */
function formatBulkResultLine(result) {
  const s = result.summary;
  const k = result.kioskStats || {};
  const p = result.paymentStats || {};
  return [
    s.mongoCampaignId,
    result.ok ? "ok" : "error",
    s.insertedCampaignId ?? "",
    s.orderNumber ?? "",
    s.campaignStatusId ?? "",
    s.salesRepUserId ?? "",
    s.customerLoginId ?? "",
    s.campaignInserted ? "1" : "0",
    s.customerCampaignInserted ? "1" : "0",
    s.salesRepUserInserted ? "1" : "0",
    s.customerAccountInserted ? "1" : "0",
    s.customerLoginInserted ? "1" : "0",
    s.customerCampaignAlreadyExists ? "1" : "0",
    k.bookingsProcessed ?? "",
    k.campaignKiosksCreated ?? "",
    k.kiosksCreated ?? "",
    k.kiosksReused ?? "",
    k.venuesCreated ?? "",
    k.venuesReused ?? "",
    k.errors?.length ?? "",
    (k.errors && k.errors.length ? k.errors.join(" || ") : ""),
    p.schedulesProcessed ?? "",
    p.invoiceHeadersCreated ?? "",
    p.paymentSchedulesCreated ?? "",
    p.errors?.length ?? "",
    (p.errors && p.errors.length ? p.errors.join(" || ") : ""),
    result.error ?? s.error ?? "",
  ]
    .map(escapeCsvCell)
    .join(",");
}

/**
 * Roll up per-campaign summaries into batch totals for end-of-run report.
 * dryRun: counts "would create" from preview fields when no INSERT happened.
 */
function aggregateBulkStats(results, dryRun) {
  const stats = {
    processed: results.length,
    ok: 0,
    failed: 0,
    campaignsInserted: 0,
    orderNumbersSet: 0,
    usersInserted: 0,
    usersReused: 0,
    customerAccountsInserted: 0,
    customerLoginsInserted: 0,
    customerCampaignsInserted: 0,
    customerCampaignsSkippedExisting: 0,
    customerCampaignsSkippedNoCustomer: 0,
    wouldCreateUser: 0,
    wouldCreateAccount: 0,
    wouldCreateLogin: 0,
    bookingsProcessed: 0,
    campaignKiosksCreated: 0,
    kiosksCreated: 0,
    kiosksReused: 0,
    venuesCreated: 0,
    venuesReused: 0,
    kioskErrors: 0,
    kioskWarnings: [],
    schedulesProcessed: 0,
    invoiceHeadersCreated: 0,
    paymentSchedulesCreated: 0,
    paymentErrors: 0,
    paymentWarnings: [],
    campaignLinks: [],
    failures: [],
  };

  for (const result of results) {
    const s = result.summary;
    const k = result.kioskStats;
    const p = result.paymentStats;

    if (!result.ok) {
      stats.failed++;
      stats.failures.push({ mongo: s.mongoCampaignId, error: result.error ?? s.error });
      continue;
    }

    stats.ok++;

    if (s.campaignInserted) {
      stats.campaignsInserted++;
      stats.orderNumbersSet++;
    } else if (dryRun) {
      stats.campaignsInserted++;
      stats.orderNumbersSet++;
    }

    if (s.salesRepUserInserted) {
      stats.usersInserted++;
    } else if (s.salesRepUserId != null) {
      stats.usersReused++;
    } else if (dryRun && s.salesRepUserPreview) {
      stats.wouldCreateUser++;
    }

    if (s.customerAccountInserted) stats.customerAccountsInserted++;
    else if (dryRun && s.customerAccountPreview) stats.wouldCreateAccount++;

    if (s.customerLoginInserted) stats.customerLoginsInserted++;
    else if (dryRun && s.customerLoginPreview) stats.wouldCreateLogin++;

    if (s.customerCampaignInserted) stats.customerCampaignsInserted++;
    if (s.customerCampaignAlreadyExists) stats.customerCampaignsSkippedExisting++;
    if (s.customerLoginId == null && s.customerCampaignSkipReason) {
      stats.customerCampaignsSkippedNoCustomer++;
    }

    // Kiosk stats
    if (k) {
      stats.bookingsProcessed += k.bookingsProcessed || 0;
      stats.campaignKiosksCreated += k.campaignKiosksCreated || 0;
      stats.kiosksCreated += k.kiosksCreated || 0;
      stats.kiosksReused += k.kiosksReused || 0;
      stats.venuesCreated += k.venuesCreated || 0;
      stats.venuesReused += k.venuesReused || 0;
      if (k.errors && k.errors.length > 0) {
        stats.kioskErrors += k.errors.length;
        stats.kioskWarnings.push({
          mongo: s.mongoCampaignId,
          sqlCampaignId: s.insertedCampaignId,
          bookingsProcessed: k.bookingsProcessed ?? 0,
          campaignKiosksCreated: k.campaignKiosksCreated ?? 0,
          errors: [...k.errors],
        });
      }
    }

    if (p) {
      stats.schedulesProcessed += p.schedulesProcessed || 0;
      stats.invoiceHeadersCreated += p.invoiceHeadersCreated || 0;
      stats.paymentSchedulesCreated += p.paymentSchedulesCreated || 0;
      if (p.errors?.length > 0) {
        stats.paymentErrors += p.errors.length;
        stats.paymentWarnings.push({
          mongo: s.mongoCampaignId,
          sqlCampaignId: s.insertedCampaignId,
          schedulesProcessed: p.schedulesProcessed ?? 0,
          invoiceHeadersCreated: p.invoiceHeadersCreated ?? 0,
          paymentSchedulesCreated: p.paymentSchedulesCreated ?? 0,
          errors: [...p.errors],
        });
      }
    }

    stats.campaignLinks.push({
      mongo: s.mongoCampaignId,
      sqlCampaignId: s.insertedCampaignId,
      orderNumber: s.orderNumber,
      orderPreview: s.orderNumberPreview,
      statusId: s.campaignStatusId,
      salesRepUserId: s.salesRepUserId,
      customerLoginId: s.customerLoginId,
      dryRun: s.dryRun,
    });
  }

  return stats;
}

/** Print detailed batch report to console after all campaigns processed. */
function printBulkStatsReport(stats, dryRun, outputPath) {
  const line = "=".repeat(72);
  const action = dryRun ? "would be created (dry run)" : "created (inserted)";

  console.log(`\n${line}`);
  console.log("BULK MIGRATION — DETAILED STATS");
  console.log(line);

  console.log("\n[Batch]");
  console.log(`  Processed:     ${stats.processed}`);
  console.log(`  Succeeded:     ${stats.ok}`);
  console.log(`  Failed:        ${stats.failed}`);
  console.log(`  Dry run:       ${dryRun ? "yes — no SQL writes" : "no"}`);

  console.log(`\n[SQL rows ${action}]`);
  console.log(`  Campaign:                 ${stats.campaignsInserted}`);
  console.log(`  Campaign OrderNumber:     ${stats.orderNumbersSet}`);
  console.log(`  Users (sales rep) new:    ${stats.usersInserted}${dryRun ? ` (+ ${stats.wouldCreateUser} would create)` : ""}`);
  console.log(`  Users (sales rep) reused: ${stats.usersReused}`);
  console.log(`  CustomerAccount new:      ${stats.customerAccountsInserted}${dryRun ? ` (+ ${stats.wouldCreateAccount} would create)` : ""}`);
  console.log(`  CustomerLogins new:       ${stats.customerLoginsInserted}${dryRun ? ` (+ ${stats.wouldCreateLogin} would create)` : ""}`);
  console.log(`  CustomerCampaigns new:    ${stats.customerCampaignsInserted}`);
  console.log(`  CustomerCampaigns skip:   ${stats.customerCampaignsSkippedExisting} (link already existed)`);
  console.log(`  CustomerCampaigns skip:   ${stats.customerCampaignsSkippedNoCustomer} (no customer resolved)`);

  console.log(`\n[Kiosk Migration]`);
  console.log(`  Bookings processed:       ${stats.bookingsProcessed}`);
  console.log(`  CampaignKiosks ${dryRun ? 'would be' : ''} linked:     ${stats.campaignKiosksCreated}`);
  console.log(`  Kiosks created:           ${stats.kiosksCreated}`);
  console.log(`  Kiosks reused:            ${stats.kiosksReused}`);
  console.log(`  Venues created:           ${stats.venuesCreated}`);
  console.log(`  Venues reused:            ${stats.venuesReused}`);
  if (stats.kioskErrors > 0) {
    console.log(`  Kiosk warnings/errors:    ${stats.kioskErrors} (see [Kiosk warnings] below)`);
  }

  console.log(`\n[Payment schedules]`);
  console.log(`  Mongo schedules processed:  ${stats.schedulesProcessed}`);
  console.log(`  InvoiceHeader ${dryRun ? "would be" : ""} created:     ${stats.invoiceHeadersCreated}`);
  console.log(`  PaymentSchedule ${dryRun ? "would be" : ""} created:   ${stats.paymentSchedulesCreated}`);
  if (stats.paymentErrors > 0) {
    console.log(`  Payment warnings/errors:  ${stats.paymentErrors} (see [Payment warnings] below)`);
  }

  const totalSqlWrites =
    stats.campaignsInserted +
    stats.orderNumbersSet +
    stats.usersInserted +
    stats.customerAccountsInserted +
    stats.customerLoginsInserted +
    stats.customerCampaignsInserted +
    stats.campaignKiosksCreated +
    stats.kiosksCreated +
    stats.venuesCreated +
    stats.invoiceHeadersCreated +
    stats.paymentSchedulesCreated;

  console.log(`\n[SQL write operations total]  +${dryRun ? 0 : totalSqlWrites} ${dryRun ? "(dry run)" : ""}`);

  console.log(`\n[Campaign list] Mongo _id → SQL Campaign.ID${dryRun ? " (dry run: IDs not assigned yet)" : ""}`);
  for (const row of stats.campaignLinks) {
    if (row.sqlCampaignId != null) {
      console.log(
        `  ${row.mongo} → Campaign.ID ${row.sqlCampaignId}  OrderNumber ${row.orderNumber ?? "—"}  StatusID ${row.statusId ?? "NULL"}  SalesRep ${row.salesRepUserId ?? "NULL"}  CustomerLogin ${row.customerLoginId ?? "NULL"}`
      );
    } else if (dryRun) {
      console.log(
        `  ${row.mongo} → (dry-run ok)  ${row.orderPreview ?? ""}  StatusID ${row.statusId ?? "NULL"}  SalesRep ${row.salesRepUserId ?? "NULL"}  CustomerLogin ${row.customerLoginId ?? "NULL"}`
      );
    }
  }

  if (stats.failures.length) {
    console.log("\n[Failures — campaign migration]");
    for (const f of stats.failures) {
      console.log(`  ${f.mongo}: ${f.error}`);
    }
  }

  if (stats.kioskWarnings?.length) {
    console.log("\n[Kiosk warnings — campaign ok, kiosk step had issues]");
    for (const w of stats.kioskWarnings) {
      const cid =
        w.sqlCampaignId != null && w.sqlCampaignId > 0 ? `SQL Campaign.ID ${w.sqlCampaignId}` : "no SQL ID";
      console.log(
        `  ${w.mongo} (${cid}) — bookings ${w.bookingsProcessed}, linked ${w.campaignKiosksCreated}, ${w.errors.length} issue(s):`
      );
      for (let i = 0; i < w.errors.length; i++) {
        console.log(`      ${i + 1}. ${w.errors[i]}`);
      }
    }
  }

  if (stats.paymentWarnings?.length) {
    console.log("\n[Payment warnings — campaign ok, payment step had issues]");
    for (const w of stats.paymentWarnings) {
      const cid =
        w.sqlCampaignId != null && w.sqlCampaignId > 0 ? `SQL Campaign.ID ${w.sqlCampaignId}` : "no SQL ID";
      console.log(
        `  ${w.mongo} (${cid}) — schedules ${w.schedulesProcessed}, invoices ${w.invoiceHeadersCreated}, payment rows ${w.paymentSchedulesCreated}, ${w.errors.length} issue(s):`
      );
      for (let i = 0; i < w.errors.length; i++) {
        console.log(`      ${i + 1}. ${w.errors[i]}`);
      }
    }
  }

  console.log(`\n[Output file]  ${outputPath}`);
  console.log(line);
}

// =============================================================================
// MAIN — read CSV → loop campaigns → write results
// =============================================================================

async function main() {
  const dryRun = DRY_RUN || getCliFlag(process.argv, "--dry-run");
  const stopOnError = STOP_ON_ERROR || getCliFlag(process.argv, "--stop-on-error");
  const inputPath = getArg(process.argv, "--input") || resolveDefaultInputPath();
  const outputPath = getArg(process.argv, "--output") || DEFAULT_OUTPUT;
  const limitArg = getArg(process.argv, "--limit");
  const limit = limitArg ? Math.max(1, parseInt(limitArg, 10)) : null;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  // Parse deduped list of valid ObjectIds from CSV
  let campaignIds = parseCampaignIdsFromCsv(fs.readFileSync(inputPath, "utf8"));
  if (!campaignIds.length) {
    console.error("No valid campaign ObjectIds in CSV (need 24-char hex _id values).");
    process.exit(1);
  }

  if (limit != null) {
    campaignIds = campaignIds.slice(0, limit);
  }

  console.log("BULK CAMPAIGN MIGRATION");
  console.log(`Input:      ${inputPath}`);
  console.log(`Campaigns:  ${campaignIds.length}`);
  console.log(`Output:     ${outputPath}`);
  console.log(`Dry run:    ${dryRun ? "yes" : "no"}`);
  console.log(`On error:   ${stopOnError ? "stop batch" : "continue"}`);
  console.log(`SQL target: ${formatSqlTarget(SQL_V3_CONNECTION_STRING)}`);
  console.log(`Logic from: migrate-single-campaign-mongo-to-sql-v3.js\n`);

  // Same connection string as single migration (TB-V1Migrate) — one pool for the batch
  const ctx = await createMigrationContext(SQL_V3_CONNECTION_STRING);
  const results = [];
  let okCount = 0;
  let failCount = 0;

  try {
    console.log(
      `Loaded ${ctx.statusRows.length} STATUSES from SQL (StatusGroup=Campaign) — shared for all rows.\n`
    );

    for (let i = 0; i < campaignIds.length; i++) {
      const mongoCampaignId = campaignIds[i];
      const prefix = `[${i + 1}/${campaignIds.length}] `;

      console.log(`${prefix}${mongoCampaignId}`);

      // verbose:false = short console line per campaign (not full single-campaign dump)
      const result = await migrateOneCampaign(ctx.pool, mongoCampaignId, {
        dryRun,
        statusLookup: ctx.statusLookup,
        verbose: false,
        logPrefix: prefix,
      });

      // Kiosks: after campaign step (real run needs SQL Campaign.ID; dry run uses placeholder)
      let kioskStats = null;
      if (result.ok) {
        const sqlCampaignIdForKiosks =
          result.summary.insertedCampaignId ?? (dryRun ? -1 : null);
        try {
          if (sqlCampaignIdForKiosks == null) {
            kioskStats = {
              ok: false,
              bookingsProcessed: 0,
              campaignKiosksCreated: 0,
              kiosksCreated: 0,
              kiosksReused: 0,
              venuesCreated: 0,
              venuesReused: 0,
              errors: ["No SQL Campaign.ID — kiosk step skipped"],
            };
          } else {
          kioskStats = await migrateCampaignKiosks(
            ctx.pool,
            mongoCampaignId,
            sqlCampaignIdForKiosks,
            { dryRun, verbose: false }
          );
          }
          logKioskIssues(
            prefix,
            mongoCampaignId,
            sqlCampaignIdForKiosks,
            kioskStats
          );
        } catch (err) {
          const msg = err.message || String(err);
          console.error(`${prefix}  [kiosks] fatal error: ${msg}`);
          if (err.stack) console.error(err.stack);
          kioskStats = {
            ok: false,
            bookingsProcessed: 0,
            campaignKiosksCreated: 0,
            kiosksCreated: 0,
            kiosksReused: 0,
            venuesCreated: 0,
            venuesReused: 0,
            errors: [`Kiosk migration fatal: ${msg}`],
          };
        }
      }

      result.kioskStats = kioskStats;

      let paymentStats = null;
      if (result.ok) {
        const sqlCampaignIdForPayments =
          result.summary.insertedCampaignId ?? (dryRun ? -1 : null);
        try {
          if (sqlCampaignIdForPayments == null) {
            paymentStats = {
              ok: false,
              schedulesProcessed: 0,
              invoiceHeadersCreated: 0,
              paymentSchedulesCreated: 0,
              errors: ["No SQL Campaign.ID — payment step skipped"],
            };
          } else {
            paymentStats = await migrateCampaignPaymentSchedules(
              ctx.pool,
              mongoCampaignId,
              sqlCampaignIdForPayments,
              { dryRun, verbose: false }
            );
          }
          logPaymentIssues(prefix, mongoCampaignId, sqlCampaignIdForPayments, paymentStats);
        } catch (err) {
          const msg = err.message || String(err);
          console.error(`${prefix}  [payments] fatal error: ${msg}`);
          paymentStats = {
            ok: false,
            schedulesProcessed: 0,
            invoiceHeadersCreated: 0,
            paymentSchedulesCreated: 0,
            errors: [`Payment migration fatal: ${msg}`],
          };
        }
      }

      result.paymentStats = paymentStats;
      results.push(result);

      if (result.ok) {
        okCount++;
        const kioskSummary = result.kioskStats
          ? ` | Kiosks: ${result.kioskStats.campaignKiosksCreated} linked, ${result.kioskStats.kiosksCreated} created, ${result.kioskStats.venuesCreated} venues`
          : "";
        const paymentSummary = result.paymentStats
          ? ` | Payments: ${result.paymentStats.paymentSchedulesCreated} rows, ${result.paymentStats.invoiceHeadersCreated} invoices`
          : "";
        if (dryRun) {
          console.log(`${prefix}  → dry-run ok${kioskSummary}${paymentSummary}`);
        } else {
          console.log(
            `${prefix}  → ok Campaign.ID=${result.summary.insertedCampaignId ?? "n/a"} OrderNumber=${result.summary.orderNumber ?? "n/a"}${kioskSummary}${paymentSummary}`
          );
        }
      } else {
        failCount++;
        console.error(`${prefix}  → FAILED: ${result.error}`);
        if (stopOnError) {
          console.error("Stopping batch (--stop-on-error).");
          break;
        }
      }
    }

    const header = [
      "mongo_campaign_id",
      "status",
      "sql_campaign_id",
      "order_number",
      "status_id",
      "sales_rep_user_id",
      "customer_login_id",
      "campaign_inserted",
      "customer_campaign_inserted",
      "user_inserted",
      "customer_account_inserted",
      "customer_login_inserted",
      "customer_campaign_already_exists",
      "bookings_processed",
      "campaign_kiosks_created",
      "kiosks_created",
      "kiosks_reused",
      "venues_created",
      "venues_reused",
      "kiosk_error_count",
      "kiosk_error_messages",
      "payment_schedules_processed",
      "invoice_headers_created",
      "payment_schedules_created",
      "payment_error_count",
      "payment_error_messages",
      "error",
    ].join(",");

    fs.writeFileSync(outputPath, `${header}\n${results.map(formatBulkResultLine).join("\n")}\n`, "utf8");

    const stats = aggregateBulkStats(results, dryRun);
    printBulkStatsReport(stats, dryRun, outputPath);

    if (failCount > 0) {
      process.exit(1);
    }
  } finally {
    await ctx.pool.close();
  }
}

main();
