import fs from "fs";

export function getArg(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return null;
  return argv[idx + 1];
}

export function isValidObjectId(value) {
  return typeof value === "string" && /^[a-f0-9]{24}$/i.test(value);
}

export function parseIdsFromCsv(content) {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const first = lines[0].toLowerCase();
  const hasHeader = [
    "_id",
    "id",
    "customer_id",
    "customerid",
    "campaign_id",
    "campaignid",
  ].includes(first);
  const ids = (hasHeader ? lines.slice(1) : lines)
    .map((line) => line.split(",")[0]?.trim())
    .filter(isValidObjectId);

  return [...new Set(ids)];
}

/** Parse campaign ObjectIds from CSV (_id / campaign_id column or one id per line). */
export function parseCampaignIdsFromCsv(content) {
  return parseIdsFromCsv(content);
}

export function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function serializeValue(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    if (typeof value.toString === "function" && value._bsontype) {
      return value.toString();
    }
    return JSON.stringify(value);
  }
  return String(value);
}

export function flattenDocument(doc, options = {}) {
  const maxDepth = options.maxDepth == null ? 6 : options.maxDepth;
  const flat = {};

  function walk(value, path, depth) {
    if (value == null) {
      flat[path] = "";
      return;
    }

    if (depth >= maxDepth) {
      flat[path] = serializeValue(value);
      return;
    }

    if (Array.isArray(value)) {
      const allPrimitive = value.every(
        (item) => item == null || ["string", "number", "boolean"].includes(typeof item)
      );
      if (allPrimitive) {
        flat[path] = value.map((item) => (item == null ? "" : String(item))).join("|");
      } else {
        flat[path] = JSON.stringify(value);
      }
      return;
    }

    if (value instanceof Date) {
      flat[path] = value.toISOString();
      return;
    }

    if (typeof value === "object") {
      if (typeof value.toHexString === "function") {
        flat[path] = value.toHexString();
        return;
      }
      if (value._bsontype && value._bsontype !== "Object") {
        flat[path] = serializeValue(value);
        return;
      }

      const keys = Object.keys(value);
      if (!keys.length) {
        flat[path] = "";
        return;
      }

      for (const key of keys) {
        const nextPath = path ? `${path}.${key}` : key;
        walk(value[key], nextPath, depth + 1);
      }
      return;
    }

    flat[path] = String(value);
  }

  walk(doc, "", 0);
  return flat;
}

export function writeCsv(filePath, headers, rows) {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => headers.map((h) => escapeCsvCell(row[h])).join(",")),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}
