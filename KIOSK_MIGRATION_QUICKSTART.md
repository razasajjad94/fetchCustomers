# Campaign + Kiosks Migration — Quick Start

## What Was Added

**New kiosk migration** runs automatically after each campaign insert in bulk migration.

### Files Created/Modified

1. **`migrate-campaign-kiosks.js`** (NEW)
   - Core logic for Venues, Kiosks, CampaignKiosks migration
   - Queries mongo: bookings → displays → venues
   - Deduplication by ImportVenueID, ImportKioskID
   - Exports: `migrateCampaignKiosks(pool, mongoCampaignId, sqlCampaignId, options)`

2. **`migrate-campaigns-bulk-from-csv.js`** (MODIFIED)
   - Calls `migrateCampaignKiosks()` after each campaign
   - Added kiosk stats to CSV output
   - Updated end report with kiosk counts

3. **`KIOSK_MIGRATION_README.md`** (NEW)
   - Full documentation
   - Field mappings
   - SQL verification queries
   - Troubleshooting

## Run Commands (Unchanged)

```bash
# Dry run (preview, no SQL writes)
npm run migrate:campaigns-bulk-from-csv:dry-run:limit5

# Real run (5 campaigns)
npm run migrate:campaigns-bulk-from-csv:limit5

# Full bulk migration (~18k campaigns)
npm run migrate:campaigns-bulk-from-csv
```

## What It Does

**For each campaign migrated:**

1. Query mongo `bookings` where `campaign = <id>`
2. For each booking:
   - Load `display` doc
   - Get `kiosk` string (e.g., "56421E") + `venue` ObjectId
3. Check SQL `Kiosks` by `ImportKioskID`
   - Exists? → Reuse
   - Missing? → Create kiosk (and venue if needed)
4. INSERT `CampaignKiosks` link

## Output Changes

### Console (per campaign)

Before:
```
[1/5] 55689924cc44750b0004d0e6
[1/5]  → ok Campaign.ID=17146 OrderNumber=15067145
```

After:
```
[1/5] 55689924cc44750b0004d0e6
  Found 3 booking(s) in Mongo for campaign ...
    Kiosk 56421E exists in SQL (ID 123)
    Linked CampaignKiosk: Campaign 17146 ↔ Kiosk 123
[1/5]  → ok Campaign.ID=17146 OrderNumber=15067145 | Kiosks: 3 linked, 1 created, 0 venues
```

### CSV (`migration_bulk_results.csv`)

**New columns:**
- `bookings_processed` - # bookings found
- `campaign_kiosks_created` - # CampaignKiosks rows
- `kiosks_created` - # new kiosks
- `kiosks_reused` - # existing kiosks
- `venues_created` - # new venues
- `venues_reused` - # existing venues
- `kiosk_errors` - # warnings

### End Report

**New section:**
```
[Kiosk Migration]
  Bookings processed:       12
  CampaignKiosks linked:    12
  Kiosks created:           3
  Kiosks reused:            9
  Venues created:           1
  Venues reused:            8
```

## Config (Edit if Needed)

**`migrate-campaign-kiosks.js` top:**

```javascript
const DEFAULT_SYSTEM_USER_ID = 1; // CreatedUserID
const DEFAULT_KIOSK_AD_PLACEMENT_ID = 1; // Adjust if needed
const DEFAULT_CONTRACT_PRICE = 0; // Fallback when mongo has no pricing
const DEFAULT_EVERGREEN_PRICE = 0; // Fallback when mongo has no pricing
```

**Pricing mapping** (from mongo `booking`):
- `ContractPrice`: tries `contract_price`, `contractPrice`, `price` → else 0
- `EvergreenPrice`: tries `evergreen_price`, `evergreenPrice`, `monthly_price` → else 0

**Mongo collections queried:**
- `bookings` - campaign → display mapping
- `displays` - kiosk string + venue ObjectId
- `venues` - venue details

**SQL tables written:**
- `Venues` - created when ImportVenueID not found
- `Kiosks` - created when ImportKioskID not found
- `CampaignKiosks` - always inserted (one per booking)

## Key Behaviors

✅ **Dry run supported** - preview only, no SQL writes for kiosks  
✅ **Deduplication** - Venues/Kiosks reused by ImportID (**NEVER updated**)  
✅ **Error tolerant** - Kiosk errors don't fail campaign  
✅ **Pricing mapped** - ContractPrice/EvergreenPrice from mongo when available, else 0  
✅ **INSERT only** - Existing venues/kiosks are **REUSED, NEVER UPDATED**  
⚠️ **No CampaignKiosks dedup** - re-run = duplicate rows

**CRITICAL:** Existing SQL data is **NEVER modified**. If `Venue ImportID = 56421` or `Kiosk ImportID = '56421E'` already exist in SQL, their data remains unchanged. We only use their IDs for new CampaignKiosks links.  

## Test It

1. **Dry run 5 campaigns:**
   ```bash
   npm run migrate:campaigns-bulk-from-csv:dry-run:limit5
   ```
   Check console output for "Found X booking(s)"

2. **Verify in SQL after real run:**
   ```sql
   SELECT * FROM CampaignKiosks WHERE CampaignID = <your_campaign_id>;
   SELECT * FROM Kiosks WHERE ImportKioskID = '56421E';
   SELECT * FROM Venues WHERE ImportVenueID = 56421;
   ```

3. **Check CSV:**
   Open `migration_bulk_results.csv` and look at new kiosk columns

## Questions?

See **`KIOSK_MIGRATION_README.md`** for:
- Full field mappings
- Troubleshooting
- SQL verification queries
- Future enhancements

---

**Summary:** Kiosk migration is now automatic. Just run bulk migration as before. Kiosks, venues, and campaign links are handled transparently.
