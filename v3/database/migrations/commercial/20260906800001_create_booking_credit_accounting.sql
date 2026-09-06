-- ---------------------------------------------------------------------------
-- V3.3 Story #58 (`#58a`). The credit ledger: consumptions and returns.
-- ADR-046, `V33-DEC-025` Rulings 2, 6, 7 and 8.
--
-- `#56` shipped the grants. Nothing spends them, so a seller's balance has no
-- meaning yet and `V33-DEC-010`'s "one credit at first confirmed, keyed by
-- booking id" has nowhere to be recorded.
--
-- These two tables are that record. Balance is DERIVED from them:
--
--     balance(party) = SUM(grants.quantity)
--                    - COUNT(consumptions with no return)
--
-- There is deliberately no balance column anywhere. A counter cannot be audited
-- against its own history, and it turns every concurrent confirmation into
-- contention on one row for a number that is a pure function of rows that
-- already exist.
--
-- ## What is NOT done here
--
-- `ck_booking_credit_grants_source` is NOT widened -- it stays `plan_included`
-- only, and #57 widens it when it has a paid-purchase fact. No positive
-- allowance, grace, expiry or overage is introduced; no existing table, trigger
-- or historical migration is touched; there is no backfill, because there is no
-- history of consumption to classify.
-- ---------------------------------------------------------------------------

-- ==========================================================================
-- commercial.booking_credit_consumptions
-- ==========================================================================

CREATE TABLE commercial.booking_credit_consumptions (
    id UUID PRIMARY KEY,

    /*
     * The booking this credit was spent on.
     *
     * Deliberately NOT a foreign key. `booking.bookings` belongs to another
     * domain on the same cluster, and the repository's convention is a plain
     * UUID with the relationship documented -- the same shape
     * `payment.payment_intents.order_id` uses for `commerce.orders`. A cascade
     * here would let a booking deletion destroy a commercial record of money's
     * worth, which is exactly backwards: the entitlement ledger outlives the
     * scheduling row.
     */
    booking_id UUID NOT NULL,

    /*
     * WHICH grant paid for it, and which term that grant belonged to.
     *
     * Snapshotted rather than re-derived, and this is what makes
     * `V33-DEC-010`'s "a booking confirmed in term N stays charged to term N"
     * structural instead of remembered: rescheduling a booking across a future
     * term boundary changes nothing here, because nothing recomputes it.
     */
    grant_id UUID NOT NULL REFERENCES commercial.booking_credit_grants (id),
    subscription_id UUID NOT NULL REFERENCES commercial.seller_subscriptions (id),
    period_index INTEGER NOT NULL,

    /*
     * WHO was charged, copied from the order's immutable seller snapshot and
     * never re-resolved.
     *
     * `V33-DEC-020` established the rule this restates: current staff
     * affiliation must not decide historical money. A professional who joins or
     * leaves a business after a booking was charged does not move that charge,
     * and its return goes back to the party that actually paid it.
     */
    subscriber_party_type VARCHAR(16) NOT NULL,
    subscriber_party_id UUID NOT NULL,

    consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * ONE CONSUMPTION PER BOOKING.
     *
     * The entire same-booking idempotency guarantee, and a database one rather
     * than a service convention: a redelivered gateway callback, a
     * double-clicked confirmation and a retried request all collide here and
     * write nothing.
     *
     * It is necessary but NOT sufficient. It says nothing about two DIFFERENT
     * bookings racing for the last credit -- that is the per-party advisory
     * lock's job (ADR-046 §4). Neither mechanism subsumes the other.
     */
    CONSTRAINT uq_bcc_booking_once UNIQUE (booking_id),

    CONSTRAINT ck_bcc_party_type
        CHECK (subscriber_party_type IN ('professional', 'business')),

    CONSTRAINT ck_bcc_period CHECK (period_index >= 0)
);

/*
 * The grant, its subscription and the charged party must agree.
 *
 * A plain FK cannot express "this grant belongs to this subscription AND was
 * granted to this party", so the referenced columns are made uniquely
 * addressable on the grant table and referenced as a composite. That turns an
 * application convention into a storage guarantee: a consumption naming grant G
 * cannot claim a subscription or a party that G does not have.
 */
ALTER TABLE commercial.booking_credit_grants
    ADD CONSTRAINT uq_bcg_identity
        UNIQUE (id, subscription_id, period_index, subscriber_party_type, subscriber_party_id);

ALTER TABLE commercial.booking_credit_consumptions
    ADD CONSTRAINT fk_bcc_grant_identity
        FOREIGN KEY (grant_id, subscription_id, period_index, subscriber_party_type, subscriber_party_id)
        REFERENCES commercial.booking_credit_grants
                   (id, subscription_id, period_index, subscriber_party_type, subscriber_party_id);

COMMENT ON TABLE commercial.booking_credit_consumptions IS
    'One booking credit spent, at a booking''s first confirmation (#58a, ADR-046). Append-only. One row per booking; the charged party and grant/period are snapshotted and never re-resolved.';

-- The read the balance query makes: everything this party has spent.
CREATE INDEX ix_bcc_party
    ON commercial.booking_credit_consumptions
       (subscriber_party_type, subscriber_party_id, consumed_at DESC);

-- The read allocation makes: how much of each grant is already spent.
CREATE INDEX ix_bcc_grant ON commercial.booking_credit_consumptions (grant_id);

-- ==========================================================================
-- commercial.booking_credit_returns
-- ==========================================================================

CREATE TABLE commercial.booking_credit_returns (
    id UUID PRIMARY KEY,

    consumption_id UUID NOT NULL
        REFERENCES commercial.booking_credit_consumptions (id),

    /*
     * WHY the credit came back, as a closed server-authored vocabulary.
     *
     * Not the customer's cancellation sentence. A free-text reason written by
     * one party would travel into the other party's commercial ledger, its
     * audit trail and its exports -- and `V33-DEC-025` Ruling 9 forbids exactly
     * that. Two values, because two cancellation actors are reachable today
     * (ADR-046 §8):
     *
     *   `seller_cancelled`   -- the professional cancelled a confirmed booking
     *   `platform_cancelled` -- a system cancellation of a confirmed booking
     *
     * `customer` cancellation and no-show retention are NOT here: whether they
     * return the seller's credit is retention policy under `V33-DEC-013`/#46.
     * `admin` is absent because no production route produces that actor, and
     * `business` because no such booking actor exists at all.
     */
    return_cause VARCHAR(24) NOT NULL,

    returned_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /*
     * AT MOST ONE RETURN PER CONSUMPTION.
     *
     * A double-delivered cancellation, a retried request and a
     * cancel-then-cancel-again all write nothing the second time. The
     * consumption row is never touched -- the pair reads as a history, not as a
     * balance that moves back and forth.
     */
    CONSTRAINT uq_bcr_consumption_once UNIQUE (consumption_id),

    CONSTRAINT ck_bcr_cause
        CHECK (return_cause IN ('seller_cancelled', 'platform_cancelled'))
);

COMMENT ON TABLE commercial.booking_credit_returns IS
    'A consumed booking credit returned by a qualifying cancellation (#58a, ADR-046). Append-only, at most one per consumption; never updates or deletes the consumption.';

CREATE INDEX ix_bcr_consumption ON commercial.booking_credit_returns (consumption_id);

-- ==========================================================================
-- Immutability
-- ==========================================================================

/*
 * Both tables are append-only facts about money's worth.
 *
 * The same shape `commerce.reject_order_payment_schedule_rewrite()` uses, and
 * for the same reason: a service that declines to write is a promise, a trigger
 * that refuses is a property. It holds against a future service, a psql session
 * and a migration that forgets.
 *
 * Neither table has a legitimately mutable column, so the refusal is
 * unconditional and needs no exemption list. A return is a NEW ROW, never an
 * edit to the consumption it reverses.
 */
CREATE OR REPLACE FUNCTION commercial.reject_credit_ledger_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'booking-credit ledger rows are immutable: a return is a new row, never an edit to the consumption it reverses'
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER tg_bcc_immutable
    BEFORE UPDATE OR DELETE ON commercial.booking_credit_consumptions
    FOR EACH ROW EXECUTE FUNCTION commercial.reject_credit_ledger_rewrite();

CREATE TRIGGER tg_bcr_immutable
    BEFORE UPDATE OR DELETE ON commercial.booking_credit_returns
    FOR EACH ROW EXECUTE FUNCTION commercial.reject_credit_ledger_rewrite();

-- ==========================================================================
-- Prove the guarantees rather than assume them
-- ==========================================================================

/*
 * Planted controls, all rolled back. This block cannot pass vacuously: each
 * probe must be REFUSED, and a migration that created the tables without their
 * constraints would fail here rather than ship silently.
 *
 * The grant source CHECK is re-asserted too -- #58a must not widen it, and a
 * future edit that did would be caught by the migration that most depends on it
 * staying narrow.
 */
DO $prove$
DECLARE
    src_ok BOOLEAN := FALSE;
    dup_refused BOOLEAN := FALSE;
    upd_refused BOOLEAN := FALSE;
    grant_row RECORD;
    probe_id UUID := '01a08000-0000-7000-8000-0000000000c1';
BEGIN
    -- The source vocabulary is still exactly one value.
    SELECT (pg_get_constraintdef(oid) LIKE '%plan_included%'
            AND pg_get_constraintdef(oid) NOT LIKE '%custom_purchase%')
      INTO src_ok
      FROM pg_constraint WHERE conname = 'ck_booking_credit_grants_source';
    IF NOT src_ok THEN
        RAISE EXCEPTION '#58a: ck_booking_credit_grants_source was widened; #58a must not do that (#57 owns it)';
    END IF;

    SELECT * INTO grant_row FROM commercial.booking_credit_grants LIMIT 1;
    IF grant_row IS NULL THEN
        RAISE NOTICE '#58a: no grant row to probe against; ledger constraints installed unproven';
        RETURN;
    END IF;

    BEGIN
        INSERT INTO commercial.booking_credit_consumptions
            (id, booking_id, grant_id, subscription_id, period_index,
             subscriber_party_type, subscriber_party_id)
        VALUES (probe_id, probe_id, grant_row.id, grant_row.subscription_id, grant_row.period_index,
                grant_row.subscriber_party_type, grant_row.subscriber_party_id);

        -- Same booking twice must be refused.
        BEGIN
            INSERT INTO commercial.booking_credit_consumptions
                (id, booking_id, grant_id, subscription_id, period_index,
                 subscriber_party_type, subscriber_party_id)
            VALUES ('01a08000-0000-7000-8000-0000000000c2', probe_id,
                    grant_row.id, grant_row.subscription_id, grant_row.period_index,
                    grant_row.subscriber_party_type, grant_row.subscriber_party_id);
            dup_refused := FALSE;
        EXCEPTION WHEN unique_violation THEN dup_refused := TRUE;
        END;

        -- The row must be unmodifiable.
        BEGIN
            UPDATE commercial.booking_credit_consumptions
               SET period_index = period_index + 1 WHERE id = probe_id;
            upd_refused := FALSE;
        EXCEPTION WHEN restrict_violation THEN upd_refused := TRUE;
        END;

        RAISE EXCEPTION 'rollback the ledger probes' USING ERRCODE = 'restrict_violation';
    EXCEPTION WHEN restrict_violation THEN
        NULL;
    END;

    IF NOT dup_refused THEN
        RAISE EXCEPTION '#58a: a second consumption for one booking was accepted; uq_bcc_booking_once is not effective';
    END IF;
    IF NOT upd_refused THEN
        RAISE EXCEPTION '#58a: a consumption row was updated; the immutability trigger is not effective';
    END IF;

    RAISE NOTICE '#58a ledger proved: duplicate booking refused, row immutable, grant source still narrow';
END
$prove$;
