-- V3.2-C Story #8, wishlist-service. The customer's private saved list
-- (ADR-033).
--
-- Every number here is an owner decision recorded in
-- `V3.2_DECISION_REGISTER.md` §C on 2026-08-30: professionals and services
-- only (`V32-DEC-020`), 500 saved items per customer and one list with no
-- named collections (`V32-DEC-021`).
--
-- ## ONE table, and the things deliberately absent from it
--
-- **No `outbox_events` table**, and `wishlist` is NOT in `ServiceName`
-- (`V32-DEC-021`). Nothing consumes a wishlist fact: `analytics.events`
-- could not accept one without widening `ck_analytics_events_subject_normalized`,
-- a notification to a professional that somebody saved them would publish a
-- private list, and a notification to a customer that a target went away
-- would disclose a third party's status change. An outbox table nothing
-- writes would still have to be claimed for subject-data coverage -- a claim
-- nobody can verify. Adding an event later is additive; shipping one nothing
-- reads is not.
--
-- **No `deleted_at`.** Removing a saved item is a hard delete and erasure is a
-- hard delete. A soft-delete column would make both claims false, and there
-- would be nowhere to record one even if somebody wanted it.
--
-- **No display snapshot columns** -- no `display_name`, price, image, city, or
-- rating (ADR-033 §7). `provider` and `search` stay authoritative for public
-- target data. A snapshot would be a stale second copy of public data PLUS a
-- subject-data claim over a third party's prose, bought in order to render
-- exactly the name the neutral-tombstone rule forbids showing.
--
-- **No `list_id` or collection column.** One list per customer
-- (`V32-DEC-021`). Named collections bring naming, ordering, and sharing
-- questions that nothing in the repository asks for.
--
-- **No target-state column.** Availability is computed per read and never
-- cached (ADR-033 §6), which is what lets a suspended-then-restored target
-- come back with no write. A cached state would be a second source of truth
-- that goes stale silently.
--
-- ## Column naming is a privacy control, not a style choice
--
-- ADR-027's boot-time coverage check rejects a `no_subject_data` claim on any
-- table carrying a subject-shaped column, and it recognises `user_id` among
-- others. The identity column is therefore named `user_id` rather than
-- `customer_id`, `owner_id`, or anything cleverer: the naming and the
-- declared disposition agree, and the check can see both. The disposition is
-- still declared explicitly and proved by test; the naming is belt, not
-- braces.
--
-- ## The tombstone is a property of what is NOT here
--
-- `V32-DEC-021` chose the surviving entry over silent removal. At this layer
-- that means: no foreign key to `provider`, no cascade, no trigger, no sweep,
-- and no retention horizon. A saved row is destroyed by exactly two things --
-- the customer removing it, and the customer erasing their account. A target
-- that is deleted or suspended changes nothing about the row.
--
-- The absence of a cross-schema foreign key is also the ordinary convention
-- (`V3_DATABASE_BLUEPRINT.md` §1); here it is additionally load-bearing,
-- because an `ON DELETE CASCADE` to `provider.professionals` would silently
-- implement the option the owner rejected.

CREATE SCHEMA IF NOT EXISTS wishlist;

-- --------------------------------------------------------------------------
-- One row per (customer, target). The whole domain.
-- --------------------------------------------------------------------------
CREATE TABLE wishlist.saved_items (
    id UUID PRIMARY KEY,

    -- The owner. ALWAYS resolved from the authenticated session; no route
    -- anywhere accepts this value from a caller, in a body, a query parameter,
    -- or a path segment.
    user_id UUID NOT NULL,

    /*
     * What was saved.
     *
     * `professional` is `provider.professionals.id`; `service` is
     * `provider.services.id`. Both are application-generated UUIDv7 primary
     * keys that survive every edit to the entity, which is why they are the
     * two approved target types and portfolio items are not -- a portfolio
     * item id does NOT survive a remove-and-re-add, because
     * `uq_portfolio_media_live` is partial on `deleted_at IS NULL`.
     *
     * A CHECK rather than an enum type: the value set is closed by
     * `V32-DEC-020` and adding a third member should be a visible migration,
     * not a `CREATE TYPE ... ADD VALUE` that cannot be rolled back inside a
     * transaction.
     */
    target_type VARCHAR(16) NOT NULL,
    target_id UUID NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_wishlist_saved_items_target_type
        CHECK (target_type IN ('professional', 'service')),

    /*
     * Saving the same target twice is UNREPRESENTABLE, and this constraint IS
     * the idempotency guarantee -- not a convenience on top of an application
     * check.
     *
     * Deliberately the same shape as `loyalty.points_entries`'
     * `uq_points_entries_reference_once`, and for the reason that migration
     * records: a SELECT-then-INSERT lets two concurrent handlers both observe
     * "not yet saved" and both insert. The index is the ONLY mechanism here,
     * so there is no weaker path to accidentally rely on, and
     * `INSERT ... ON CONFLICT DO NOTHING` becomes idempotent by construction.
     */
    CONSTRAINT uq_wishlist_saved_items_user_target
        UNIQUE (user_id, target_type, target_id)
);

-- The list, and the ONLY ordering this module offers.
--
-- Keyset pagination reads exactly this: newest first, with `id` as the
-- tie-break so two items saved in the same millisecond cannot make a page
-- boundary skip or repeat a row. V2 used offset pagination and had to fix an
-- unbounded list twice.
CREATE INDEX ix_wishlist_saved_items_user_keyset
    ON wishlist.saved_items (user_id, created_at DESC, id DESC);

-- The cap count, and the subject-data export and erasure, all read one
-- customer's rows. Partial index would gain nothing -- every row has a
-- user_id.
CREATE INDEX ix_wishlist_saved_items_user
    ON wishlist.saved_items (user_id);

-- --------------------------------------------------------------------------
-- What is NOT created, stated so a later reader does not assume an omission
-- --------------------------------------------------------------------------
--
-- No `wishlist.outbox_events`. No `wishlist.collections`. No
-- `wishlist.saved_item_counters` -- the 500-item cap is enforced by a
-- transaction-scoped advisory lock keyed on the subject, taken before the
-- count, rather than by a denormalised counter row (ADR-033 §8).
--
-- The counter shape used by `ai.usage_daily` and `chat.send_counters` is
-- correct where a RATE is limited over time, because there the counter is the
-- state. Here the rows are the state, and a counter would only shadow them --
-- it would need a decrement on every remove and on erasure, and it could
-- drift from the rows it claims to count. `loyalty` refuses a cached balance
-- for exactly this reason.
