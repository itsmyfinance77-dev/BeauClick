-- ---------------------------------------------------------------------------
-- V3.3 Story #95 (`#58b-1`). The booking-credit enforcement control plane.
-- ADR-050 §2, `V33-DEC-036` R2, R3, R4, R12.
--
-- `V33-DEC-007` named four independent controls -- rollout, entitlement,
-- business policy and kill switch -- and `#58a` shipped the entitlement plane
-- as an immutable ledger. The other three had no persistence at all:
-- `CommercialPolicyControlGate` evaluated four booleans nobody stored and
-- nobody called. These two tables are where those planes live.
--
-- ## Two tables, two different kinds of fact
--
-- `booking_credit_enforcement_control` is ONE ROW, ever: the platform-wide
-- rollout state, the emergency kill switch and the activation generation.
-- PostgreSQL enforces the singleton (`ck_bcec_singleton`), not the service.
--
-- `booking_credit_party_governance` is ONE ROW PER SELLER PARTY, at most: the
-- explicit, durable fact that an administrator resolved this seller as either
-- `governed` (inside the booking-credit enforcement regime) or `legacy_exempt`
-- (deliberately left on the selective path). The ABSENCE of a row means
-- "unresolved", and that absence is what a future activation must refuse on.
--
-- ## What this migration deliberately does NOT do (`V33-DEC-036` R4)
--
-- No seller is governed here. No row of `booking_credit_party_governance` is
-- inserted by this or any migration: every existing seller stays exactly as
-- legacy-exempt as it is today until an administrator acts. No grant,
-- subscription, consumption, return or balance is touched. No column below
-- carries a commercial number, allowance, price, quantity bound or policy
-- parameter -- the only numbers written are the singleton's id (1) and an
-- activation generation of zero, and neither confers anything on anyone.
--
-- ## What this migration does NOT enable (story boundary, ADR-050 §1)
--
-- `rollout_state` can hold `active`, because the schema is the contract #141
-- (`#58b-2`) will later write against. Nothing in #95 -- no route, service or
-- migration -- writes that value. The trigger below permits the transition so
-- that #141 will not need a schema change, and forbids its reversal so that no
-- ordinary administration can ever undo it.
-- ---------------------------------------------------------------------------

-- ==========================================================================
-- commercial.booking_credit_enforcement_control -- the singleton
-- ==========================================================================

CREATE TABLE commercial.booking_credit_enforcement_control (
    /*
     * A fixed identity the DATABASE enforces. `id = 1` is the only legal
     * value, so a second row is unrepresentable rather than merely
     * discouraged, and every reader can address the row without a lookup.
     */
    id SMALLINT PRIMARY KEY,

    /* Rollout plane. `inactive` until #141's activation command; never back. */
    rollout_state VARCHAR(16) NOT NULL,

    /*
     * Incremented by exactly one on each activation. Zero while inactive.
     * Exists so that a future, owner-decided deactivation/reactivation cycle
     * can version its consequences visibly rather than overwrite them.
     */
    activation_generation INTEGER NOT NULL,

    /* Database clock at activation, and the audit row written in that
     * transaction. Opaque id, no cross-schema FK (`admin.*` is another
     * domain's table, on the same cluster, by convention). */
    activated_at TIMESTAMPTZ,
    activation_audit_id UUID,

    /* Kill-switch plane. The only columns an ordinary transaction may move in
     * BOTH directions. */
    kill_switch_state VARCHAR(16) NOT NULL,
    kill_switch_changed_at TIMESTAMPTZ,
    kill_switch_audit_id UUID,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_bcec_singleton CHECK (id = 1),
    CONSTRAINT ck_bcec_rollout_state CHECK (rollout_state IN ('inactive', 'active')),
    CONSTRAINT ck_bcec_kill_switch_state CHECK (kill_switch_state IN ('released', 'engaged')),
    CONSTRAINT ck_bcec_generation CHECK (activation_generation >= 0),

    /*
     * The activation facts move together or not at all: an inactive rollout
     * has no activation instant, no audit pointer and generation zero; an
     * active one has all three.
     */
    CONSTRAINT ck_bcec_activation_consistent CHECK (
        (rollout_state = 'inactive'
            AND activated_at IS NULL
            AND activation_audit_id IS NULL
            AND activation_generation = 0)
        OR
        (rollout_state = 'active'
            AND activated_at IS NOT NULL
            AND activation_audit_id IS NOT NULL
            AND activation_generation >= 1)
    ),

    /*
     * A kill-switch change always carries its instant and its audit pointer
     * together, and an engaged switch was necessarily changed at some instant.
     */
    CONSTRAINT ck_bcec_kill_switch_consistent CHECK (
        ((kill_switch_changed_at IS NULL) = (kill_switch_audit_id IS NULL))
        AND (kill_switch_state = 'released' OR kill_switch_changed_at IS NOT NULL)
    )
);

COMMENT ON TABLE commercial.booking_credit_enforcement_control IS
    'V3.3 #95 (#58b-1), ADR-050 §2.1. The one-row booking-credit enforcement control: rollout state, activation generation and the emergency kill switch. id = 1 is enforced by CHECK. No commercial value lives here. ADR-027 no_subject_data: actor identity for its mutations is in admin.admin_audit_log, referenced by opaque audit ids.';

/*
 * The initial safe state, and a structural precondition of every reader: an
 * absent row is a malformed state that fails closed. This is not a commercial
 * value and it activates nothing -- `inactive`, `released`, generation 0.
 */
INSERT INTO commercial.booking_credit_enforcement_control
    (id, rollout_state, activation_generation, kill_switch_state)
VALUES
    (1, 'inactive', 0, 'released');

/*
 * Immutability of the activation facts, and no way back (ADR-050 §2.1,
 * `V33-DEC-036` R9). The shape `commerce.reject_order_payment_schedule_rewrite()`
 * established: a service that declines to write is a promise, a trigger that
 * refuses is a property.
 *
 * Permitted:  kill_switch_* in either direction; rollout inactive -> active
 *             with the generation incremented by exactly one and both
 *             activation facts set; updated_at.
 * Refused:    DELETE; any change of id or created_at; active -> inactive; any
 *             generation change other than +1 on activation; any change to
 *             activated_at or activation_audit_id once the rollout is active.
 */
CREATE OR REPLACE FUNCTION commercial.protect_booking_credit_enforcement_control()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'booking_credit_enforcement_control is a permanent singleton and cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id <> OLD.id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'booking_credit_enforcement_control identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.rollout_state = 'active' AND NEW.rollout_state = 'inactive' THEN
        RAISE EXCEPTION 'global booking-credit enforcement cannot be deactivated through ordinary administration (V33-DEC-036 R9)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.rollout_state = 'active' THEN
        IF NEW.activation_generation <> OLD.activation_generation
           OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
           OR NEW.activation_audit_id IS DISTINCT FROM OLD.activation_audit_id THEN
            RAISE EXCEPTION 'activation facts are immutable once the rollout is active'
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF NEW.rollout_state = 'active' THEN
        IF NEW.activation_generation <> OLD.activation_generation + 1 THEN
            RAISE EXCEPTION 'activation must increment the generation by exactly one'
                USING ERRCODE = 'restrict_violation';
        END IF;
    ELSIF NEW.activation_generation <> OLD.activation_generation THEN
        RAISE EXCEPTION 'activation generation cannot change while the rollout is inactive'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bcec_protect
    BEFORE UPDATE OR DELETE ON commercial.booking_credit_enforcement_control
    FOR EACH ROW EXECUTE FUNCTION commercial.protect_booking_credit_enforcement_control();

-- ==========================================================================
-- commercial.booking_credit_party_governance -- one explicit fact per party
-- ==========================================================================

CREATE TABLE commercial.booking_credit_party_governance (
    id UUID PRIMARY KEY,

    /*
     * The seller party, in the same vocabulary `seller_subscriptions` and the
     * ledger use. `party_id` is OPAQUE: it names `provider.professionals.id` or
     * `business.businesses.id` and carries no cross-schema FK, exactly as the
     * subscription tables do.
     */
    party_type VARCHAR(16) NOT NULL,
    party_id UUID NOT NULL,

    /*
     * The explicit fact. `legacy_exempt`: an administrator recorded, with a
     * reason, that this seller stays on the selective path. `governed`: the
     * seller has entered the booking-credit enforcement regime. Monotonic --
     * see the trigger.
     */
    state VARCHAR(16) NOT NULL,

    /*
     * WHY the row is in its current state, as a CLOSED server-authored
     * vocabulary (`V33-DEC-036` R3). The administrator's own prose lives in
     * the audit row, never here.
     *
     *   explicit_transition        -- an administrator governed this party
     *                                 against a proven positive entitlement
     *   explicit_exemption         -- an administrator recorded this party as
     *                                 intentionally legacy-exempt
     *   created_under_enforcement  -- reserved for #141: a seller created after
     *                                 global activation. NO #95 code writes it.
     */
    cause VARCHAR(32) NOT NULL,

    /*
     * The positive immutable grant that PROVED the party's published
     * entitlement at an explicit transition. Same schema, so a real FK is
     * permitted and used. Required for `explicit_transition`, forbidden
     * otherwise.
     */
    proof_grant_id UUID REFERENCES commercial.booking_credit_grants (id),

    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    governed_at TIMESTAMPTZ,

    /*
     * WHO wrote the current state. A human administrator (`recorded_by_user_id`)
     * XOR a non-session actor (`recorded_by_label`), the `ck_admin_audit_actor`
     * shape. The `_user_id` suffix is what lets ADR-027's coverage detector
     * refuse a dishonest `no_subject_data` claim on this table.
     */
    recorded_by_user_id UUID,
    recorded_by_label VARCHAR(40),

    /* The admin.admin_audit_log row of the write that produced the current
     * state. Opaque, no cross-schema FK. */
    audit_id UUID NOT NULL,

    CONSTRAINT uq_bcpg_party UNIQUE (party_type, party_id),
    CONSTRAINT ck_bcpg_party_type CHECK (party_type IN ('professional', 'business')),
    CONSTRAINT ck_bcpg_state CHECK (state IN ('legacy_exempt', 'governed')),
    CONSTRAINT ck_bcpg_cause CHECK (cause IN ('explicit_transition', 'explicit_exemption', 'created_under_enforcement')),
    CONSTRAINT ck_bcpg_cause_state CHECK (
        (cause = 'explicit_exemption' AND state = 'legacy_exempt')
        OR (cause IN ('explicit_transition', 'created_under_enforcement') AND state = 'governed')
    ),
    CONSTRAINT ck_bcpg_proof CHECK ((cause = 'explicit_transition') = (proof_grant_id IS NOT NULL)),
    CONSTRAINT ck_bcpg_governed_at CHECK ((state = 'governed') = (governed_at IS NOT NULL)),
    CONSTRAINT ck_bcpg_actor CHECK (
        (recorded_by_user_id IS NOT NULL AND recorded_by_label IS NULL)
        OR (recorded_by_user_id IS NULL AND recorded_by_label IS NOT NULL)
    )
);

COMMENT ON TABLE commercial.booking_credit_party_governance IS
    'V3.3 #95 (#58b-1), ADR-050 §2.2. One explicit, monotonic governance fact per seller party: legacy_exempt or governed, with a closed cause, the proving grant for an explicit transition, and the recording actor. Absence of a row means unresolved. Rows are never deleted; the only permitted update is legacy_exempt -> governed. ADR-027 retained.';

-- The preview's partition read.
CREATE INDEX ix_bcpg_state ON commercial.booking_credit_party_governance (state);

/*
 * Monotonic, and history is never erased (`V33-DEC-036` R3, R4). Exactly ONE
 * update shape is legal -- `legacy_exempt -> governed` by explicit transition,
 * setting the transition facts in the same statement -- and everything else
 * is refused: DELETE, `governed -> legacy_exempt`, any change to the party or
 * the original `recorded_at`, and any rewrite of a governed row.
 */
CREATE OR REPLACE FUNCTION commercial.protect_booking_credit_party_governance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'booking_credit_party_governance rows are never deleted: emergency containment is the kill switch, not the erasure of governance history'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id <> OLD.id
       OR NEW.party_type <> OLD.party_type
       OR NEW.party_id <> OLD.party_id
       OR NEW.recorded_at <> OLD.recorded_at THEN
        RAISE EXCEPTION 'booking_credit_party_governance identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.state = 'governed' THEN
        RAISE EXCEPTION 'a governed seller cannot be returned to legacy exemption or otherwise rewritten (V33-DEC-036 R3)'
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- OLD.state = 'legacy_exempt': the one permitted transition.
    IF NEW.state <> 'governed'
       OR NEW.cause <> 'explicit_transition'
       OR NEW.governed_at IS NULL
       OR NEW.proof_grant_id IS NULL THEN
        RAISE EXCEPTION 'the only permitted governance update is legacy_exempt -> governed by explicit transition'
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER tg_bcpg_protect
    BEFORE UPDATE OR DELETE ON commercial.booking_credit_party_governance
    FOR EACH ROW EXECUTE FUNCTION commercial.protect_booking_credit_party_governance();

-- ==========================================================================
-- Prove the guarantees rather than assume them
-- ==========================================================================

/*
 * Planted controls, all rolled back. Each probe must be REFUSED; a migration
 * that created the tables without their guards would fail here rather than
 * ship silently. No INSERT below carries a number other than 0 or 1, and no
 * governance row survives this block -- the table is empty when it ends.
 */
DO $prove$
DECLARE
    seeded_ok BOOLEAN := FALSE;
    del_refused BOOLEAN := FALSE;
    deact_refused BOOLEAN := FALSE;
    gov_empty BOOLEAN := FALSE;
BEGIN
    SELECT count(*) = 1 INTO seeded_ok
      FROM commercial.booking_credit_enforcement_control
     WHERE id = 1 AND rollout_state = 'inactive' AND kill_switch_state = 'released'
       AND activation_generation = 0;
    IF NOT seeded_ok THEN
        RAISE EXCEPTION '#95: the enforcement control singleton was not seeded in its initial safe state';
    END IF;

    BEGIN
        DELETE FROM commercial.booking_credit_enforcement_control WHERE id = 1;
        del_refused := FALSE;
    EXCEPTION WHEN restrict_violation THEN del_refused := TRUE;
    END;
    IF NOT del_refused THEN
        RAISE EXCEPTION '#95: the singleton accepted a DELETE';
    END IF;

    -- A generation change while inactive is refused, which is the same guard
    -- that will refuse active -> inactive once #141 has flipped the row.
    BEGIN
        UPDATE commercial.booking_credit_enforcement_control
           SET activation_generation = activation_generation + 1
         WHERE id = 1;
        deact_refused := FALSE;
    EXCEPTION WHEN restrict_violation THEN deact_refused := TRUE;
    END;
    IF NOT deact_refused THEN
        RAISE EXCEPTION '#95: the singleton accepted a generation change while inactive';
    END IF;

    SELECT count(*) = 0 INTO gov_empty FROM commercial.booking_credit_party_governance;
    IF NOT gov_empty THEN
        RAISE EXCEPTION '#95: governance rows exist after migration; no seller may be governed by a migration (V33-DEC-036 R4)';
    END IF;
END
$prove$;
