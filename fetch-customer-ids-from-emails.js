#!/usr/bin/env node
/**
 * PIPELINE 1 of 2 — Emails → Customer IDs
 *
 * Input:  EmailsResult.csv          (column: email / login_email)
 * Query:  customers collection      { login_email: <email> }
 * Output: customer_ids_from_emails.csv  (column: _id = customer ObjectId)
 *
 * Run: npm run fetch:customer-ids-from-emails
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongodb from "mongodb";
import { getMongoConfig, logMongoTarget } from "./mongo-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUT = path.join(__dirname, "EmailsResult.csv");
const DEFAULT_OUTPUT = path.join(__dirname, "customer_ids_from_emails.csv");
const { MongoClient } = mongodb;

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function parseEmailsFromCsv(content) {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const headerParts = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const emailIndex = headerParts.findIndex((h) =>
    ["email", "login_email", "customer_contact_email"].includes(h)
  );

  if (emailIndex !== -1) {
    return lines
      .slice(1)
      .map((line) => {
        const parts = line.split(",");
        return parts[emailIndex] ? parts[emailIndex].trim() : "";
      })
      .filter(Boolean);
  }

  return lines
    .map((line) => {
      const first = line.split(",")[0];
      return first ? first.trim() : "";
    })
    .filter(Boolean);
}

async function main() {
  const inputPath = getArg("--input") || DEFAULT_INPUT;
  const outputPath = getArg("--output") || DEFAULT_OUTPUT;

  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const config = getMongoConfig();
  const { uri: mongoUri, dbName, collectionName } = config;
  logMongoTarget(config);

  const csvContent = fs.readFileSync(inputPath, "utf8");
  const emails = [...new Set(parseEmailsFromCsv(csvContent))];

  if (!emails.length) {
    console.error("No emails found in input CSV.");
    process.exit(1);
  }

  console.log(`Emails to lookup: ${emails.length}`);

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const collection = client.db(dbName).collection(collectionName);

    const docs = await collection
      .find({ login_email: { $in: emails } }, { projection: { _id: 1 } })
      .toArray();

    const outputLines = ["_id", ...docs.map((d) => String(d._id))];
    fs.writeFileSync(outputPath, `${outputLines.join("\n")}\n`, "utf8");

    console.log(`Matched customer IDs: ${docs.length}`);
    console.log(`Output written to: ${outputPath}`);
    if (docs.length === 0) {
      console.warn(
        "No matches. In mongo-config.js set MONGO_DB_NAME to the database name from Compass (sidebar)."
      );
    }
  } catch (error) {
    console.error("Mongo query failed:", error.message);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();
