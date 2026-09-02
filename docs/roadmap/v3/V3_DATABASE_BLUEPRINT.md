# V3 Database Blueprint

> **Current-status note (2026-09-02):** This file preserves the Phase 0 target model.
> The implemented database now has ordered SQL migrations and later ADR amendments,
> especially ADR-017 and ADR-027. Treat claims below about no database or migration as
> historical baseline statements.

Status: Phase 0 blueprint. **No migrations have been written, no database created.** Decision basis: `docs/roadmap/v3/adr/ADR-004-database-strategy.md`. This document specifies conventions and an initial entity list for Phase 1+ to implement against.

---

## 1. Database strategy

**One PostgreSQL cluster, one schema per module** (`V3_DOMAIN_BOUNDARIES.md`'s 13 modules + `admin`/`privacy`), not one database per module. Rationale: at current team/operational scale (ADR-002), running 15 separate Postgres instances is pure operational overhead with no isolation benefit beyond what schema-level role/grant separation already gives — except **financial** and **payment**, which get their own physically separate database (not merely schema) matching their separate-deployable status (ADR-002 #2, ADR-009): a compromised or buggy `apps/api` process should not even hold a connection string capable of touching the ledger.

| Module | Database | Schema | Notes |
|---|---|---|---|
| identity, provider, search¹, booking, commerce, loyalty, referral, notification, analytics, ai, journey, admin, privacy | `beauclick` (shared cluster, one DB) | one schema each, matching the module name | `apps/api` connects with one role per schema-write-scope; cross-schema queries are never written by application code (mirrors V2's own "no cross-plugin FKs" discipline, now enforced as "no cross-schema queries" instead) |
| financial | `beauclick_financial` (separate DB) | `financial` | Role: `financial_writer` — `INSERT` only on `ledger_entries` (no `UPDATE`/`DELETE` grant at all, ADR-009); a separate `financial_reader` role for read-only summary queries |
| payment | `beauclick_payment` (separate DB) | `payment` | Role scoped to `apps/payment-service` exclusively; no other app's connection pool is ever configured with credentials to this database |

¹ search-service's real store is OpenSearch (`V3_DOMAIN_BOUNDARIES.md`); its Postgres schema, if any, holds only reindex-job bookkeeping.

## 2. Naming conventions

- **Schemas**: lower_snake_case, exactly matching the owning module name (`identity`, `provider`, `booking`, …).
- **Tables**: lower_snake_case, plural nouns, no module prefix inside the schema (the schema qualifier already disambiguates — `provider.professionals`, not `provider.provider_professionals`).
- **Columns**: lower_snake_case. Foreign keys: `{referenced_singular}_id` (`provider_id`, `booking_id`). Boolean columns: `is_`/`has_` prefix (`is_launched`, `has_evidence`).
- **Indexes**: `ix_{table}_{columns}`. Unique constraints: `uq_{table}_{columns}`. Foreign keys: `fk_{table}_{referenced_table}`.
- **Migration files**: `{schema}/{timestamp}_{description}.sql` (timestamp-prefixed for deterministic ordering within a schema, per §4).

## 3. Migration strategy

- **Tooling**: a real migration framework with up/down scripts and a version-tracking table per schema (e.g. `node-pg-migrate` or Prisma Migrate — final tool choice deferred to Phase 1 implementation, not an architecture decision this blueprint needs to lock).
- **Expand/contract pattern, mandatory for any breaking change**: add new column/table (expand) → deploy code that writes both old and new shape → backfill → deploy code that reads only the new shape → drop the old column/table (contract) in a later migration. No single migration may both add a `NOT NULL` column and deploy code assuming it exists in the same release — this is the direct fix for the class of risk `GAP-03`'s "self-heals only by accident" gap represents: never rely on deploy-ordering luck.
- **Migrations run as a separate CI/CD step before the corresponding app deploy**, never bundled into application startup (`V3_INFRASTRUCTURE_PLAN.md` — a running app instance must never race another instance's schema migration).
- **Per-schema ownership**: only the module that owns a schema may author migrations against it — `services/financial`'s migrations live under `database/migrations/financial/` and only `apps/financial-service`'s deploy pipeline applies them.
- **No data migration from V2** (ADR-010) — every Phase 1+ migration creates fresh V3-native schema; reference data (locations, specialties) is seeded (§7), not migrated row-by-row.

## 4. UUID strategy

**UUIDv7 (time-ordered) as the primary key type for every new table**, not auto-increment integers and not plain UUIDv4. Rationale:
- Avoids the sequential-ID enumeration property `V3_SECURITY_MODEL.md` §3 already flags as a risk to avoid ("never let an error message allow enumeration of which resource IDs are valid") — a random-looking ID is a small additional layer, though the real defense remains the ownership check itself, not ID obscurity.
- UUIDv7's time-ordered prefix keeps B-tree index locality good (unlike UUIDv4, which fragments indexes) — avoids the naive "UUIDs are always worse for index performance" tradeoff.
- Globally unique across schemas/databases without coordination — required once financial/payment are physically separate databases (an auto-increment integer PK could collide across databases if ever needed for cross-database reference/export).
- `V2 provider_id` was a WordPress **post ID** (an integer), not a user ID — the exact source of a real, documented V2 bug class (`ARCHITECTURE_PROPOSAL.md` Implementation Notes, `ProviderLookup::for_user()`). Moving to UUIDs for every entity removes the entire "which integer ID am I holding" ambiguity class at the type level — a `ProfessionalId` and a `UserId` become distinct branded types in TypeScript, not both bare `number`.

## 5. Audit columns

Every table (except where explicitly noted) carries:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK, UUIDv7, generated application-side (not DB `gen_random_uuid()`, so the same ID is known before insert for event-envelope construction) |
| `created_at` | `timestamptz` | Never null, defaults to insert time |
| `updated_at` | `timestamptz` | Never null, updated by application code on every write (not a DB trigger — keeps write-path logic visible in one place) |
| `created_by` | `uuid`, nullable | References `identity.users.id`; null for system/seed-inserted rows |
| `updated_by` | `uuid`, nullable | Same |

**Exceptions**: `financial.ledger_entries` and `admin.admin_audit_log` have `created_at`/`created_by` only — no `updated_at`/`updated_by`, because these tables are append-only by design (no row is ever updated after insert, ADR-009/`V3_SECURITY_MODEL.md` §7).

## 6. Soft-delete policy

**Nullable `deleted_at timestamptz`** on tables representing user-facing entities where "removed but recoverable/auditable" is the correct product behavior (professionals, businesses, services, portfolio items, reviews, bookings-as-cancelled-is-already-a-status-not-a-delete). Application queries default to `WHERE deleted_at IS NULL`; a `libs/http` base-repository helper enforces this by default so a forgotten `WHERE` clause can't leak soft-deleted rows.

**Hard exceptions — no soft delete, ever**:
- `financial.ledger_entries`, `admin.admin_audit_log` — append-only, no delete of any kind, enforced at the DB role level (ADR-009).
- `identity.users` — account deletion uses the anonymization pattern extracted from V2's `AccountEraser` (`V3_MIGRATION_MATRIX.md` Privacy section), not a delete flag — PII fields are overwritten, the row and its ID persist for referential integrity across every schema that holds a `user_id`.
- Reference data (`provider.specialties`, location tables) — never deleted, only deactivated (`is_launched`/`is_active` flags, preserving V2's own `is_launched` pattern verbatim).

## 7. Event storage strategy — transactional outbox

**Every module that produces domain events (per `V3_DOMAIN_BOUNDARIES.md`) writes to its own `{schema}.outbox_events` table in the *same* database transaction as the business write**, not a direct Kafka publish from application code. A separate relay process (Debezium-style CDC, or a simple polling publisher — implementation choice for Phase 2, not decided here) tails each schema's outbox table and publishes to Kafka, marking rows published. This guarantees **at-least-once delivery with no dual-write inconsistency** — the exact class of bug `GAP-03` (booking→order creation with no idempotency guard) represents, generalized: a business write and its corresponding event must never be allowed to happen independently of each other.

`outbox_events` columns: `id` (uuid), `aggregate_type`, `aggregate_id`, `event_type`, `event_version`, `payload` (jsonb), `created_at`, `published_at` (nullable). Every consumer's idempotency strategy (per `V3_EVENT_ARCHITECTURE.md`) is still required on the *consuming* side — the outbox pattern guarantees delivery, not exactly-once processing.

## 8. Initial entity list

Schema-qualified, derived directly from `WORDPRESS_EXIT_MATRIX.md` §2/§4's confirmed 34-table + 4-CPT V2 inventory, remapped onto `V3_DOMAIN_BOUNDARIES.md`'s modules. **Not a full DDL — no migrations are written from this list.**

```
identity.users
identity.otp_requests
identity.phone_conflicts
identity.refresh_tokens
identity.roles
identity.capabilities
identity.business_account_approvals

provider.professionals
provider.businesses
provider.services
provider.portfolio_items
provider.specialties
provider.verification_requests
provider.verification_evidence
provider.verification_history
provider.business_staff
provider.reviews
provider.wishlist_items

booking.availability_slots
booking.bookings
booking.booking_reschedules
booking.waitlist_entries
booking.crm_notes

commerce.orders
commerce.order_items
commerce.pricing_rule_applications
commerce.campaigns
commerce.campaign_usages
commerce.b2b_price_tiers
commerce.quotes

payment.payment_intents           -- separate database
payment.provider_callbacks        -- separate database
payment.refunds                   -- separate database

financial.ledger_entries          -- separate database, append-only
financial.settlement_batches      -- separate database
financial.settlement_items        -- separate database

loyalty.loyalty_points
loyalty.loyalty_tiers
loyalty.membership_plans
loyalty.memberships
loyalty.loyalty_benefits

referral.referral_codes
referral.referrals

notification.notifications
notification.notification_preferences

analytics.event_store             -- time-partitioned; replaces wp_bc_events

ai.ai_conversations
ai.ai_messages
ai.ai_professional_conversations
ai.ai_professional_messages
ai.ai_recommendation_events

journey.beauty_profiles
journey.beauty_goals

admin.admin_audit_log             -- append-only

privacy.data_requests

-- reference data, seeded not migrated (ADR-010 §2):
provider.locations_provinces
provider.locations_cities
provider.locations_districts
```

**Net-new tables with no direct V2 precedent**: `identity.refresh_tokens` (V2 had no token infrastructure at all), `payment.*` (no real gateway ever integrated), every `outbox_events` table (§7 — V2 had no formal event contract at all).

---

## Cross-references
- `ADR-004-database-strategy.md` — the decision this blueprint operationalizes.
- `ADR-009-financial-ledger.md` — the append-only enforcement requirement behind §1/§5/§6's financial exceptions.
- `V3_DOMAIN_BOUNDARIES.md` — the module-to-schema mapping this entity list follows.
- `V3_EVENT_ARCHITECTURE.md` — how `outbox_events` rows become real Kafka messages.
