/**
 * =============================================================================
 * CAMPAIGN BILLING INFO — Mongo campaigns → SQL CampaignBillingInfo
 * =============================================================================
 *
 * FLOW (after Campaign insert):
 *   1. Load mongo campaigns doc by _id
 *   2. Map billing fields + computed PaymentFrequency / monthly / down payment
 *   3. INSERT one CampaignBillingInfo row per SQL Campaign.ID
 *
 * Mongo collection: campaigns (mydb)
 *
 * Direct mapping:
 *   campaign_installment_payments     → PaymentCount
 *   misc_production_fee               → ProductionFee
 *   campaign_amount                   → SubTotal, Total
 *
 * Constants:
 *   Discount = 0
 *   BillingStartDate = null
 *   SplitPayments = 0
 *
 * Formulas (from mongo campaign doc):
 *   PaymentFrequency = campaign_duration > 0 ? 5 : 4
 *   MonthlyPaymentAmount = campaign_amount / campaign_duration  (0 if duration <= 0)
 *   DownPaymentAmount = campaign_amount - (campaign_installment_payments_made * MonthlyPaymentAmount)
 */
import mongodb from "mongodb";
import { getMongoConfig } from "./mongo-config.js";
import { sql } from "./sql-connection.js";

const { MongoClient, ObjectId } = mongodb;

const MONGO_CAMPAIGNS_COLLECTION = "campaigns";
const SQL_CAMPAIGN_BILLING_INFO_TABLE = "CampaignBillingInfo";

/** PaymentFrequency when campaign_duration > 0 */
const PAYMENT_FREQUENCY_WITH_DURATION = 5;
/** PaymentFrequency when campaign_duration is 0 or missing */
const PAYMENT_FREQUENCY_NO_DURATION = 4;

const DEFAULT_DISCOUNT = 0;
const DEFAULT_SPLIT_PAYMENTS = 0;

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

function parseMoney(value, defaultValue = 0) {
  if (value == null || value === "") return defaultValue;
  const num = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(num)) return defaultValue;
  return Math.round(num * 100) / 100;
}

function parseIntField(value, defaultValue = null) {
  if (value == null || value === "") return defaultValue;
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : defaultValue;
}

function roundMoney(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

// =============================================================================
// MONGO
// =============================================================================

async function fetchMongoCampaign(mongoCampaignIdHex) {
  if (!mongoCampaignIdHex) return null;

  const config = getMongoConfig();
  const client = new MongoClient(config.uri);
  try {
    await client.connect();
    return await client
      .db(config.dbName)
      .collection(MONGO_CAMPAIGNS_COLLECTION)
      .findOne({ _id: new ObjectId(mongoCampaignIdHex) });
  } finally {
    await client.close();
  }
}

// =============================================================================
// MAPPING
// =============================================================================

/**
 * Build SQL CampaignBillingInfo row from mongo campaigns document.
 * @returns {{ row: object|null, errors: string[] }}
 */
function mapMongoCampaignToBillingInfo(mongoDoc, sqlCampaignId) {
  const errors = [];

  if (!mongoDoc) {
    return { row: null, errors: ["Mongo campaign document not found"] };
  }

  const campaignAmount = parseMoney(mongoDoc.campaign_amount, 0);
  const campaignDuration = parseIntField(mongoDoc.campaign_duration, 0);
  const installmentsMade = parseIntField(
    mongoDoc.campaign_installment_payments_made,
    0
  );

  const paymentFrequency =
    campaignDuration > 0 ? PAYMENT_FREQUENCY_WITH_DURATION : PAYMENT_FREQUENCY_NO_DURATION;

  const monthlyPaymentAmount =
    campaignDuration > 0 ? roundMoney(campaignAmount / campaignDuration) : 0;

  const downPaymentAmount = roundMoney(
    campaignAmount - installmentsMade * monthlyPaymentAmount
  );

  const paymentCount = parseIntField(mongoDoc.campaign_installment_payments, null);

  if (campaignAmount < 0) {
    errors.push(`campaign_amount is negative (${campaignAmount})`);
  }

  const row = {
    CampaignID: sqlCampaignId,
    PaymentCount: paymentCount,
    ProductionFee: parseMoney(mongoDoc.misc_production_fee, 0),
    SubTotal: campaignAmount,
    Discount: DEFAULT_DISCOUNT,
    Total: campaignAmount,
    PaymentFrequency: paymentFrequency,
    DownPaymentAmount: downPaymentAmount,
    MonthlyPaymentAmount: monthlyPaymentAmount,
    BillingStartDate: null,
    SplitPayments: DEFAULT_SPLIT_PAYMENTS,
  };

  return { row, errors };
}

// =============================================================================
// SQL INSERT
// =============================================================================

async function insertCampaignBillingInfoRow(pool, row) {
  const request = pool.request();
  request.input("campaignID", sql.Int, row.CampaignID);
  request.input("paymentCount", sql.Int, row.PaymentCount);
  request.input("productionFee", sql.Money, row.ProductionFee);
  request.input("subTotal", sql.Money, row.SubTotal);
  request.input("discount", sql.Money, row.Discount);
  request.input("total", sql.Money, row.Total);
  request.input("paymentFrequency", sql.Int, row.PaymentFrequency);
  request.input("downPaymentAmount", sql.Money, row.DownPaymentAmount);
  request.input("monthlyPaymentAmount", sql.Money, row.MonthlyPaymentAmount);
  request.input("billingStartDate", sql.Date, row.BillingStartDate);
  request.input("splitPayments", sql.Bit, row.SplitPayments);

  const result = await request.query(`
    INSERT INTO ${SQL_CAMPAIGN_BILLING_INFO_TABLE} (
      CampaignID, PaymentCount, ProductionFee, SubTotal, Discount, Total,
      PaymentFrequency, DownPaymentAmount, MonthlyPaymentAmount, BillingStartDate, SplitPayments
    )
    OUTPUT INSERTED.ID AS InsertedBillingInfoId
    VALUES (
      @campaignID, @paymentCount, @productionFee, @subTotal, @discount, @total,
      @paymentFrequency, @downPaymentAmount, @monthlyPaymentAmount, @billingStartDate, @splitPayments
    );
  `);

  return result.recordset[0].InsertedBillingInfoId;
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
export async function migrateCampaignBillingInfo(
  pool,
  mongoCampaignIdHex,
  sqlCampaignId,
  options = {}
) {
  const dryRun = options.dryRun === true;
  const verbose = options.verbose !== false;

  const stats = {
    ok: true,
    billingInfoCreated: 0,
    errors: [],
    preview: null,
  };

  try {
    const mongoDoc = await fetchMongoCampaign(mongoCampaignIdHex);
    const { row, errors: mapErrors } = mapMongoCampaignToBillingInfo(
      mongoDoc,
      sqlCampaignId
    );

    if (mapErrors.length) {
      stats.errors.push(...mapErrors);
    }

    if (!row) {
      if (!stats.errors.length) {
        stats.errors.push("Could not build CampaignBillingInfo row");
      }
      return stats;
    }

    stats.preview = {
      PaymentCount: row.PaymentCount,
      ProductionFee: row.ProductionFee,
      SubTotal: row.SubTotal,
      Total: row.Total,
      PaymentFrequency: row.PaymentFrequency,
      MonthlyPaymentAmount: row.MonthlyPaymentAmount,
      DownPaymentAmount: row.DownPaymentAmount,
    };

    if (verbose) {
      console.log(
        `  [billing] PaymentCount=${row.PaymentCount ?? "null"} Total=${row.Total} ` +
          `Monthly=${row.MonthlyPaymentAmount} Down=${row.DownPaymentAmount} ` +
          `Freq=${row.PaymentFrequency}`
      );
    }

    if (dryRun) {
      stats.billingInfoCreated = 1;
      if (verbose) {
        console.log(
          `    [DRY RUN] CampaignBillingInfo for Campaign.ID ${sqlCampaignId}`
        );
      }
      return stats;
    }

    try {
      const insertedId = await insertCampaignBillingInfoRow(pool, row);
      stats.billingInfoCreated = 1;
      if (verbose) {
        console.log(
          `    CampaignBillingInfo ID ${insertedId} → Campaign.ID ${sqlCampaignId}`
        );
      }
    } catch (insertErr) {
      stats.errors.push(formatMigrationError(insertErr));
    }
  } catch (error) {
    stats.ok = false;
    stats.errors.push(`Billing info migration fatal: ${formatMigrationError(error)}`);
  }

  return stats;
}
