# Campaign Schema Mapping Report

**MongoDB `campaigns` collection → SQL Server `Campaign` table**

| | |
|---|---|
| **Date** | June 2, 2026 |
| **Scope** | Field-level mapping assessment for migration / ETL planning |
| **Source** | Sample Mongo campaign document + provided SQL `Campaign` schema |

---

## 1. Executive Summary

This report compares a representative MongoDB campaign document with the SQL Server `Campaign` table schema.

- **12 fields** are recommended for direct or lookup-based mapping into `Campaign` or related keys.
- **8 Mongo fields** are campaign-related but belong in **other SQL tables** (billing, customer, integrations).
- **15+ SQL columns** have **no reliable Mongo source** in the sample document and will need defaults, derivation, or separate sources.

Mapping requires **ID bridge tables** (Mongo ObjectId ↔ SQL `int`) for `_id`, `salesrep`, `customer`, and `designer`, plus a **status lookup** (`campaign_status` string → `StatusID` int).

---

## 2. Mappable Fields (Recommended)

### 2.1 High confidence — map to `Campaign`

| # | Mongo field | SQL column | Transform / notes |
|---|-------------|------------|-------------------|
| 1 | `created` | `CreatedDate` | ISO datetime → `datetime` |
| 2 | `updated` | `LastUpdated` | ISO datetime → `datetime` |
| 3 | `campaign_duration` | `CampaignDuration` | Direct `int` |
| 4 | `campaign_bonus_month` | `BonusMonths` | Direct `int` |
| 5 | `estimated_start_date` | `EstimatedStartDate` | Date normalization |
| 6 | `campaign_auto_renews` | `Evergreen` | Boolean → `bit` |
| 7 | `campaign_booked_date` | `SignedDate` | Confirm with business; booked ≈ signed |
| 8 | `campaign_status` | `StatusID` | Requires status dictionary (e.g. `"completed"` → int) |
| 9 | `salesrep` | `SalesRep` | ObjectId → SQL user `int` via mapping table |
| 10 | `salesforce_opportunity_id` | `CRMDealID` | Validate format (`varchar` vs `bigint`) |
| 11 | `_id` | `ID` | Not equal values — use migration map: Mongo `_id` hex ↔ SQL `ID` |
| 12 | `customer` | *(Customer FK)* | Not on `Campaign` row; map to Customer table `CustomerID` / legacy key |

### 2.2 Medium confidence — map after business confirmation

| Mongo field | SQL column | Condition |
|-------------|------------|-----------|
| `campaign_start_date` | `EstimatedStartDate` | Use only if `estimated_start_date` is null; avoid double-mapping |
| `campaign_renewal_date` | `EvergreenCancelDate` | Confirm renewal vs cancel semantics |
| `designer` | `ArtDesigner` | Mongo text (`"in-house"`) → user `int` via lookup |
| `salesrep` | `LegacySalesRepID` | Use when `SalesRep` is new-system ID only |
| `art_completed` | `ArtApprovalDate` | Boolean completion → approval date (rule needed) |
| `pulled_down` / `pull_down_date` | Takedown workflow | No single SQL column; may drive status or separate process table |

### 2.3 Derivable (not stored in Mongo sample)

| SQL column | Derivation |
|------------|------------|
| `EstimatedEndDate` | `EstimatedStartDate` + `CampaignDuration` (if duration is months, apply calendar rule) |

---

## 3. Campaign-Related Mongo Fields — Map Outside `Campaign` Table

These are campaign data in Mongo but should not be forced into the SQL `Campaign` table shown.

| Mongo field | Recommended SQL target |
|-------------|------------------------|
| `campaign_amount` | Billing / pricing table |
| `campaign_payment_status` | Payment table |
| `campaign_payment_method` | Payment table |
| `campaign_installment_payments` | Installment / billing table |
| `campaign_installment_payments_made` | Installment / billing table |
| `stripe_subscription_id` | Stripe / billing integration |
| `stripe_coupon_id` | Promo / billing table |
| `salesforce_account_id` | CRM account mapping table |

---

## 4. Cannot Be Mapped (or No Safe 1:1)

### 4.1 Mongo campaign fields — no matching SQL `Campaign` column

| Mongo field | Reason |
|-------------|--------|
| `short_url` | No SQL column |
| `searchable_text` | Denormalized search blob; not `Name` |
| `campaign_artwork_printer` | No SQL column |
| `campaign_addon_*` (drip mats, brochure holder, etc.) | Addon flags — separate table |
| `campaign_one_time_amount` | Billing |
| `campaign_price_adjustment` | Billing / pricing |
| `additional_fee_payment_history` | Array — child table |
| `art_change_fee` | Billing |
| `campaign_auto_renewal_log` | Array — audit/history table |
| `campaign_bonus_weeks` | SQL has `BonusMonths` only |
| `campaign_duration_type` | Implied by duration; no column |
| `campaign_renewal_optin_optout_status` | No direct column |
| `continuity_visits` | Array — separate table |
| `ip_transfer_fee`, `misc_production_fee` | Fee/billing |
| `thumbnails` | Array — media/assets table |
| `ad_posted` | Ops flag — no SQL column in schema |
| `__v` | Mongo version key — discard |

### 4.2 SQL `Campaign` columns — no Mongo source in sample

| SQL column | Notes |
|------------|--------|
| `Name` | Not present as dedicated field in Mongo sample |
| `CreatedUserID`, `LastUpdatedUserID` | No Mongo audit user fields |
| `OrderNumber` | No Mongo field |
| `ReservationTypeID` | No Mongo field |
| `GenericArtwork` | No Mongo field |
| `MarketingSpecialist` | No Mongo field |
| `CustomerCare` | No Mongo field |
| `Telemarketer` | No Mongo field |
| `CustomerSuccessManager` | No Mongo field |
| `AppointmentID` | No Mongo field |
| `ContractedKioskTotal` | No Mongo field |
| `SurplusKioskTotal` | No Mongo field |
| `BumpableKioskTotal` | No Mongo field |
| `BumpedKioskTotal` | No Mongo field |
| `TimeSensative` | No Mongo field |
| `TakedownPriorityDays` | No direct field (workflow only) |
| `DigitalContractID` | No direct field |
| `ContractID` | No direct field |
| `LegacyArtDesignerID` | Use `designer` map or leave null |
| `LegacyFieldCoordID` | No Mongo field |
| `LegacyMarketingSpecialistID` | No Mongo field |
| `LegacyCustomerCareID` | No Mongo field |
| `LegacyTelemarketerID` | No Mongo field |
| `LegacyAppointmentID` | No Mongo field |
| `LegacyUserID` | No Mongo field |
| `TestCampaign` | No Mongo field |
| `LegacyBillingInfoID` | Billing bridge |
| `RenewalCampaignId` | Needs prior campaign link — not in sample |
| `LeadTypeId` | No Mongo field |
| `CampaignMeta` | No Mongo field |
| `CampaignBasis` | No Mongo field |

---

## 5. Recommended ETL Mapping Set (Phase 1)

**Target table: `Campaign`**

```
created                    → CreatedDate
updated                    → LastUpdated
campaign_duration          → CampaignDuration
campaign_bonus_month       → BonusMonths
estimated_start_date       → EstimatedStartDate
campaign_auto_renews       → Evergreen
campaign_booked_date       → SignedDate
campaign_status            → StatusID          [lookup]
salesrep                   → SalesRep          [ObjectId→int]
salesforce_opportunity_id  → CRMDealID
_id                        → ID                [mapping table]
customer                   → CustomerID        [separate Customer load]
```

**Phase 2:** Billing, addons, installments, Salesforce account, art/ops flags → child or integration tables.

---

## 6. Risks & Dependencies

1. **ID mapping** — Mongo ObjectId and SQL `int` are different systems; maintain `mongo_campaign_id` ↔ `Campaign.ID`.
2. **Status dictionary** — `campaign_status` strings must map to `StatusID` values.
3. **Duplicate dates** — `campaign_start_date` vs `estimated_start_date`; define precedence.
4. **User references** — `salesrep`, `designer` need user/legacy ID bridges.
5. **One customer, many campaigns** — One customer can have many campaign `_id`s; SQL `RenewalCampaignId` may link related rows separately.

---

## 7. Conclusion

A focused migration can populate the core SQL `Campaign` row from approximately **10–12 Mongo fields**. Payment, addons, arrays, and most kiosk/legacy/role columns require **other sources or default nulls**. Do not attempt to map all Mongo fields into `Campaign`; split by domain (core campaign, billing, CRM, ops/art).

---

*End of report*
