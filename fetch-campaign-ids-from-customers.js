#!/usr/bin/env node
/**
 * PIPELINE 2 of 2 — Customer IDs → Campaign IDs
 *
 * Input:  customer_ids_from_emails.csv   (column: _id = customer ObjectId)
 * Query:  campaigns collection           { customer: ObjectId(<customer _id>) }
 * Output: campaign_ids_from_customers.csv (column: _id = campaign ObjectId)
 *
 * Run: npm run fetch:campaign-ids-from-customers
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongodb from "mongodb";
import { getMongoConfig, logByCustomerTarget } from "./mongo-config.js";
import { getArg, parseIdsFromCsv } from "./csv-utils.js";

const { MongoClient, ObjectId } = mongodb;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUT = path.join(__dirname, "customer_ids_from_emails.csv");
const DEFAULT_OUTPUT = path.join(__dirname, "campaign_ids_from_customers.csv");
const BATCH_SIZE = 500;

function chunk(array, size) {
  const parts = [];
  for (let i = 0; i < array.length; i += size) {
    parts.push(array.slice(i, i + size));
  }
  return parts;
}

async function main() {
  const inputPath = getArg(process.argv, "--input") || DEFAULT_INPUT;
  const outputPath = getArg(process.argv, "--output") || DEFAULT_OUTPUT;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const config = getMongoConfig();
  logByCustomerTarget(config);

  const customerIds = parseIdsFromCsv(fs.readFileSync(inputPath, "utf8"));
  if (!customerIds.length) {
    console.error("No valid ObjectIds found in input CSV.");
    process.exit(1);
  }

  console.log(`Customer IDs to lookup in campaigns: ${customerIds.length}`);

  const client = new MongoClient(config.uri);
  const campaignIds = new Set();

  try {
    await client.connect();
    const collection = client.db(config.dbName).collection(config.byCustomerCollection);
    const field = config.customerField;

    for (const batch of chunk(customerIds, BATCH_SIZE)) {
      const objectIds = batch.map((id) => new ObjectId(id));
      const docs = await collection
        .find({ [field]: { $in: objectIds } }, { projection: { _id: 1 } })
        .toArray();

      for (const doc of docs) {
        campaignIds.add(String(doc._id));
      }
    }

    const outputLines = ["_id", ...campaignIds];
    fs.writeFileSync(outputPath, `${outputLines.join("\n")}\n`, "utf8");

    console.log(`Campaign IDs matched: ${campaignIds.size}`);
    console.log(`Output written to: ${outputPath}`);
  } catch (error) {
    console.error("Mongo query failed:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
