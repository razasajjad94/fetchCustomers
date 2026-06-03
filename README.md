# Mongo ID Export Pipeline

Two-step pipeline: emails → customer IDs → campaign IDs.

| Step | Script file | npm command | Input | Output |
|------|-------------|-------------|-------|--------|
| 1 | `fetch-customer-ids-from-emails.js` | `npm run fetch:customer-ids-from-emails` | `EmailsResult.csv` | `customer_ids_from_emails.csv` |
| 2 | `fetch-campaign-ids-from-customers.js` | `npm run fetch:campaign-ids-from-customers` | `customer_ids_from_emails.csv` | `campaign_ids_from_customers.csv` |

## MongoDB config

Edit `mongo-config.js`:

- `MONGO_URI`, `MONGO_DB_NAME` — connection
- `MONGO_COLLECTION_NAME` — `customers` (pipeline 1)
- `MONGO_BY_CUSTOMER_COLLECTION` — `campaigns` (pipeline 2)
- `MONGO_CUSTOMER_FIELD` — `customer` (pipeline 2 filter field)

## Install

```bash
npm install
```

## Run full pipeline

```bash
npm run fetch:customer-ids-from-emails
npm run fetch:campaign-ids-from-customers
```

## Optional flags

```bash
node fetch-customer-ids-from-emails.js --input EmailsResult.csv --output customer_ids_from_emails.csv
node fetch-campaign-ids-from-customers.js --input customer_ids_from_emails.csv --output campaign_ids_from_customers.csv
```

## 3) Migrate one campaign — Mongo → SQL v3

Edit the **CONFIG** section at the top of **`migrate-single-campaign-mongo-to-sql-v3.js`**:

- `MONGO_CAMPAIGN_ID_TO_MIGRATE` — which Mongo campaign `_id` to migrate
- `SQL_V3_CONNECTION_STRING` — SQL Server v3 database
- Status / salesrep / customer ID lookup maps

Dry run (no insert):

```bash
npm run migrate:single-campaign-to-sql-v3 -- --dry-run
```

Migrate:

```bash
npm install
npm run migrate:single-campaign-to-sql-v3
```

Script: `migrate-single-campaign-mongo-to-sql-v3.js`  
Mapping reference: `Campaign_Schema_Mapping_Report.md`
