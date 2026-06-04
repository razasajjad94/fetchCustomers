# Campaign Kiosks Migration

## Overview

Automated migration of campaign kiosks from MongoDB to SQL Server v3. This feature runs **automatically** after each campaign is migrated, linking campaigns to their associated kiosks, venues, and ad placements.

## Architecture

### Files

- **`migrate-campaign-kiosks.js`** - Core kiosk migration logic (exported function)
- **`migrate-campaigns-bulk-from-csv.js`** - Orchestrator (calls kiosk migration after each campaign)
- **`migrate-single-campaign-mongo-to-sql-v3.js`** - Single campaign migration (unchanged)

### Flow

For each campaign after successful SQL Campaign insert:

1. **Query MongoDB `bookings`** collection where `campaign = <mongo_campaign_id>`
2. For each booking:
   - Load **`display`** document by ObjectId
   - Extract `display.kiosk` (string, e.g., "56421E") and `display.venue` (ObjectId)
3. **Check SQL `Kiosks`** by `ImportKioskID = display.kiosk`
   - If exists → reuse `Kiosk.ID`
   - If missing → create kiosk (and venue if needed)
4. **Check SQL `Venues`** by `ImportVenueID` (from mongo `venue.import_venue_id`)
   - If exists → reuse `Venue.ID`
   - If missing → INSERT venue from mongo `venues` collection
5. **INSERT `CampaignKiosks`** linking `CampaignID ↔ KioskID`

## Mapped Fields

### CampaignKiosks (SQL)

| SQL Column | Source | Notes |
|------------|--------|-------|
| `CampaignID` | SQL Campaign.ID | After campaign insert |
| `KioskID` | SQL Kiosks.ID | Lookup or create |
| `ReservationStart` | mongo booking.booking_start_date | Date |
| `ReservationEnd` | mongo booking.booking_end_date | Date |
| `Bumpable` | Default: 0 | Placeholder |
| `Boosted` | Default: 0 | Placeholder |
| `ContractPrice` | mongo booking.contract_price / price | **From mongo if available, else 0** |
| `EvergreenPrice` | mongo booking.evergreen_price / monthly_price | **From mongo if available, else 0** |
| `KioskAdPlacementID` | Default: 1 | Adjust CONFIG if needed |
| `CreatedDate` | mongo booking.created or now | DateTime |
| `CreatedUserID` | Default: 1 | System user |

### Kiosks (SQL) — created when missing

| SQL Column | Source | Notes |
|------------|--------|-------|
| `ImportKioskID` | mongo display.kiosk | e.g., "56421E" |
| `VenueID` | SQL Venues.ID | After venue insert |
| `IsDigital` | Default: 0 | Adjust if mongo has flag |
| `Sellable` | Default: 1 | Boolean |
| `Retired` | Default: 0 | Boolean |
| `CreatedDate` | now | DateTime |
| `CreatedUserID` | Default: 1 | System user |

### Venues (SQL) — created when missing

| SQL Column | Source | Notes |
|------------|--------|-------|
| `VenueName` | mongo venue.name | Required |
| `Address1` | mongo venue.address | varchar(255) |
| `City` | mongo venue.city | varchar(100) |
| `State` | mongo venue.state | varchar(2) |
| `Zip` | mongo venue.zip_code | varchar(10) |
| `County` | mongo venue.county | varchar(100) |
| `DMA` | mongo venue.dma | varchar(100) |
| `Longitude` | mongo venue.longitude | varchar(50) |
| `Latitude` | mongo venue.latitude | varchar(50) |
| `StoreNumber` | mongo venue.store_number | varchar(50) |
| `Retired` | mongo venue.retired | Boolean |
| `ImportVenueID` | mongo venue.import_venue_id | Integer |
| `CreatedDate` | mongo venue.created or now | DateTime |
| `CreateUserID` | Default: 1 | System user |
| `PermanentlyClosed` | Default: 0 | Boolean |
| `Sellable` | mongo venue.sellable == "yes" | Boolean |

## Configuration

Edit **`migrate-campaign-kiosks.js`** (top of file):

```javascript
const DEFAULT_SYSTEM_USER_ID = 1; // User ID for Created/Updated fields
const DEFAULT_KIOSK_AD_PLACEMENT_ID = 1; // Adjust based on your SQL data
const DEFAULT_CONTRACT_PRICE = 0; // Fallback when mongo has no pricing
const DEFAULT_EVERGREEN_PRICE = 0; // Fallback when mongo has no pricing
```

**Pricing field mapping** (from mongo `booking` document):
- `ContractPrice` tries: `contract_price`, `contractPrice`, `price`
- `EvergreenPrice` tries: `evergreen_price`, `evergreenPrice`, `monthly_price`
- Falls back to defaults (0) if fields missing or invalid

MongoDB collections:
- `bookings` - links campaigns to displays
- `displays` - links kiosks to venues
- `venues` - venue details
- `kiosks` - kiosk details (optional, not currently queried)

## Deduplication & Reuse Strategy

**CRITICAL: NO UPDATES TO EXISTING ROWS**

| Table | Lookup Key | Behavior |
|-------|-----------|----------|
| **Venues** | `ImportVenueID` | SELECT by ImportVenueID → if found: **REUSE existing ID (no data update)** → if not found: **INSERT new venue** |
| **Kiosks** | `ImportKioskID` | SELECT by ImportKioskID → if found: **REUSE existing ID (no data update)** → if not found: **INSERT new kiosk** |
| **CampaignKiosks** | None | **Always INSERT** (one row per booking, no duplicate check) |

### What This Means

✅ **Existing venues are never modified** - if `ImportVenueID = 56421` exists in SQL, we use that Venue.ID and don't touch the venue data  
✅ **Existing kiosks are never modified** - if `ImportKioskID = '56421E'` exists in SQL, we use that Kiosk.ID and don't touch the kiosk data  
✅ **Only INSERT operations** - new venues/kiosks created only when ImportID not found  
⚠️ **Re-running creates duplicates** - CampaignKiosks has no dedup check (same campaign + kiosk = duplicate row)

### Example Flow

**Scenario:** Campaign has 2 bookings, both use `Kiosk = "56421E"` at `Venue ImportID = 56421`

**First Run:**
1. Check SQL: Venue 56421 **not found** → INSERT new Venue (ID 100)
2. Check SQL: Kiosk 56421E **not found** → INSERT new Kiosk (ID 500, VenueID 100)
3. INSERT CampaignKiosk (CampaignID 17146, KioskID 500)
4. Booking 2: Kiosk 56421E **found** (ID 500) → REUSE
5. INSERT CampaignKiosk (CampaignID 17146, KioskID 500)

**Second Run (same campaign):**
1. Check SQL: Venue 56421 **found** (ID 100) → REUSE (no insert, no update)
2. Check SQL: Kiosk 56421E **found** (ID 500) → REUSE (no insert, no update)
3. INSERT CampaignKiosk (CampaignID 17146, KioskID 500) ← **Duplicate row**
4. INSERT CampaignKiosk (CampaignID 17146, KioskID 500) ← **Duplicate row**

Re-running the same campaign **creates duplicate** `CampaignKiosks` rows (no duplicate check by design).

## Dry Run

```bash
npm run migrate:campaigns-bulk-from-csv:dry-run:limit5
```

- Queries Mongo (bookings, displays, venues)
- Checks SQL (kiosks, venues existence)
- **No SQL writes** (Campaign, Kiosks, Venues, CampaignKiosks)
- Previews what would be created

## Output

### Console (per campaign)

```
[1/5] 55689924cc44750b0004d0e6
  Found 3 booking(s) in Mongo for campaign 55689924cc44750b0004d0e6
    Kiosk 56421E exists in SQL (ID 123)
    Linked CampaignKiosk: Campaign 17146 ↔ Kiosk 123
    Kiosk 56422A not found, creating...
      Venue ImportID 56421 exists in SQL (ID 89)
      Created kiosk: 56422A (SQL ID 456)
    Linked CampaignKiosk: Campaign 17146 ↔ Kiosk 456
[1/5]  → ok Campaign.ID=17146 OrderNumber=15067145 | Kiosks: 3 linked, 1 created, 0 venues
```

### CSV (`migration_bulk_results.csv`)

New columns:
- `bookings_processed` - # of bookings found for campaign
- `campaign_kiosks_created` - # of CampaignKiosks rows inserted
- `kiosks_created` - # of new Kiosks rows
- `kiosks_reused` - # of existing kiosks found
- `venues_created` - # of new Venues rows
- `venues_reused` - # of existing venues found
- `kiosk_errors` - # of warnings/errors during kiosk migration

### End Report

```
========================================================================
BULK MIGRATION — DETAILED STATS
========================================================================

[Batch]
  Processed:     5
  Succeeded:     5
  Failed:        0
  Dry run:       no

[SQL rows created (inserted)]
  Campaign:                 5
  Campaign OrderNumber:     5
  Users (sales rep) new:    2
  Users (sales rep) reused: 3
  CustomerAccount new:      1
  CustomerLogins new:       1
  CustomerCampaigns new:    5
  CustomerCampaigns skip:   0 (link already existed)
  CustomerCampaigns skip:   0 (no customer resolved)

[Kiosk Migration]
  Bookings processed:       12
  CampaignKiosks linked:    12
  Kiosks created:           3
  Kiosks reused:            9
  Venues created:           1
  Venues reused:            8

[SQL write operations total]  +34

[Campaign list] Mongo _id → SQL Campaign.ID
  55689924cc44750b0004d0e6 → Campaign.ID 17146  OrderNumber 15067145  ...
  ...
========================================================================
```

## Error Handling

Kiosk migration errors **do not fail** the campaign:
- Campaign insert always succeeds
- Kiosk warnings logged but batch continues
- Check `kiosk_errors` column in CSV for campaigns with issues

Common warnings:
- "Booking has no display"
- "Display not found in Mongo"
- "Display has no kiosk field"
- "Venue not found in Mongo"

## Mapped Pricing Fields

**ContractPrice** - mapped from mongo `booking` document:
- Tries: `contract_price` → `contractPrice` → `price`
- Falls back to 0 if missing

**EvergreenPrice** - mapped from mongo `booking` document:
- Tries: `evergreen_price` → `evergreenPrice` → `monthly_price`
- Falls back to 0 if missing

## Skipped Fields

**Optional fields not currently mapped:**
- `CampaignKiosks.InstallDate`, `InstalledImageUrl`, `LastUpdated`, `LastUpdatedUserID`, `ReservationStatusID`, `DigitalSeconds`, `Exclusive`, `PrintCollectionId`
- `Kiosks.KioskTypeID`, `KioskLocationID`, `DigitalTotalTime`, `DigitalReservedTime`, `VistarID`, `MonthlyImpressions`, `InstallDate`, etc.
- `Venues.VenueTypeID`, `VenueCompanyID`, `VenueRank`, `Indoor`, `HasPharmacy`, `ContractedKiosks`, etc.

Add these later if needed by updating mapping functions in `migrate-campaign-kiosks.js`.

## Testing Workflow

1. **Dry run (5 campaigns)**
   ```bash
   npm run migrate:campaigns-bulk-from-csv:dry-run:limit5
   ```
   - Check console for "Found X booking(s)"
   - Review kiosk stats in report

2. **Small real run (5 campaigns)**
   ```bash
   npm run migrate:campaigns-bulk-from-csv:limit5
   ```
   - Verify SQL rows in `CampaignKiosks`, `Kiosks`, `Venues`
   - Check CSV for kiosk counts

3. **Full migration**
   ```bash
   npm run migrate:campaigns-bulk-from-csv
   ```
   - ~18k campaigns × avg bookings per campaign
   - Monitor kiosk errors

## SQL Verification Queries

```sql
-- Check CampaignKiosks for a campaign
SELECT * FROM CampaignKiosks WHERE CampaignID = 17146;

-- Check kiosk by import ID
SELECT * FROM Kiosks WHERE ImportKioskID = '56421E';

-- Check venue by import ID
SELECT * FROM Venues WHERE ImportVenueID = 56421;

-- Count kiosks created by migration (today)
SELECT COUNT(*) FROM Kiosks
WHERE CreatedUserID = 1 AND CAST(CreatedDate AS DATE) = CAST(GETDATE() AS DATE);

-- Campaigns with kiosk links
SELECT c.ID, c.Name, COUNT(ck.ID) AS KioskCount
FROM Campaign c
LEFT JOIN CampaignKiosks ck ON c.ID = ck.CampaignID
WHERE c.CreatedUserID = 1 -- Migration user
GROUP BY c.ID, c.Name;
```

## Troubleshooting

### No bookings found for campaign
- Check mongo `bookings` collection: `db.bookings.find({ campaign: ObjectId("...") })`
- Campaign may have no displays/kiosks assigned in legacy system

### "Display has no kiosk field"
- Display document in mongo is incomplete
- Check: `db.displays.findOne({ _id: ObjectId("...") })`
- Campaign skips that booking, continues with others

### "Venue not found in Mongo"
- Display references a venue ObjectId that doesn't exist
- Check: `db.venues.findOne({ _id: ObjectId("...") })`
- Kiosk creation fails for that booking only

### Kiosk already exists error
- Duplicate `ImportKioskID` in SQL from previous run
- Script reuses existing kiosk (by design)
- If SQL row is corrupted, manually fix or delete

### Performance
- ~18k campaigns × ~2 bookings avg = ~36k Mongo queries
- Expect ~30-60 minutes for full run (network + SQL writes)
- Run during off-hours for production DB

## Future Enhancements

1. Add pricing fields mapping (ContractPrice, EvergreenPrice from mongo?)
2. Map KioskTypeID, KioskLocationID via lookup tables
3. Map ReservationStatusID from booking_status string
4. Query mongo `kiosks` collection for richer kiosk data
5. Add `CampaignKiosks` deduplication check (prevent duplicate bookings)
6. Parallel processing for bookings (async batch)
7. Retry logic for transient Mongo connection errors
