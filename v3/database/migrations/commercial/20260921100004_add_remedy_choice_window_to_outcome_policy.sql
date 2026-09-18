-- ---------------------------------------------------------------------------
-- V3.3 Story #161 (`#42d`) — adds the nullable, administrator-published
-- `remedy_choice_window_hours` to the numeric outcome-policy family
-- (ADR-051 §8, migration ordering: "the numeric family gains
-- remedy_choice_window_hours NULL (additive, no rewrite)").
--
-- ## What this column is, and what it deliberately is not yet
--
-- ADR-051 §8 names this column as "the mechanism an administrator publishes"
-- for a remedy response deadline, but ratifies no value and no timed-wait
-- behaviour for it: "This ADR does not choose a deadline; the owner ratified
-- no number for it, and the immediate-default reading is the fail-closed
-- one." This story therefore only ADDS the column — additive, nullable, no
-- default, exactly like every other administrator value on this table — and
-- reads it nowhere as anything other than "NULL, so the default executes
-- immediately at cancellation" (today's behaviour, unconditionally). A future
-- story may ratify and implement a genuine timed-wait mechanism for a
-- non-NULL value; until then, publishing one changes nothing observable, by
-- design, rather than triggering unratified behaviour.
--
-- ## No table is created; no existing row is rewritten
--
-- `commercial.booking_outcome_policy_versions` is #42a's own table
-- (`20260918100001_create_booking_outcome_policy_family.sql`), already
-- applied wherever this platform runs. This migration only ALTERs it to add
-- one nullable column and widens its lifecycle-immutability function
-- (`CREATE OR REPLACE`, same trigger, no re-creation) to freeze the new
-- column once a version leaves `draft` — exactly as every other term on this
-- table is already frozen.
-- ---------------------------------------------------------------------------

ALTER TABLE commercial.booking_outcome_policy_versions
    ADD COLUMN remedy_choice_window_hours SMALLINT;

ALTER TABLE commercial.booking_outcome_policy_versions
    ADD CONSTRAINT ck_bopv_remedy_choice_window CHECK (
        remedy_choice_window_hours IS NULL OR remedy_choice_window_hours BETWEEN 1 AND 8760
    );

-- `CREATE OR REPLACE FUNCTION` redefines the SAME function `tg_bopv_lifecycle`
-- already calls — no trigger is dropped or recreated. Identical to #42a's
-- original body except the new column joins the "frozen once published" list.
CREATE OR REPLACE FUNCTION commercial.enforce_booking_outcome_version_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_late_options INTEGER;
    v_no_show_options INTEGER;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions must be created as draft: publication is a transition, not an initial state'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.lifecycle_state <> 'draft' THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot be deleted once published: a version a booking may have snapshotted is not removable'
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lifecycle_state = 'retired' THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions is retired and permanently immutable: restore earlier terms by publishing a new version'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_by_label IS DISTINCT FROM OLD.created_by_label
    THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions identity is immutable: id, policy_key, version and the creation record cannot be changed'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
       AND NOT (
             (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published')
          OR (OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired')
       )
    THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions transition % -> % is not permitted: the lifecycle is draft -> published -> retired and never backwards',
            OLD.lifecycle_state, NEW.lifecycle_state
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Every term and the window, frozen the moment the version leaves draft.
    -- V3.3 #161: remedy_choice_window_hours joins this list, additive.
    IF OLD.lifecycle_state <> 'draft' AND (
           NEW.cutoff_hours_allowed IS DISTINCT FROM OLD.cutoff_hours_allowed
        OR NEW.no_show_grace_minutes_allowed IS DISTINCT FROM OLD.no_show_grace_minutes_allowed
        OR NEW.reschedule_free_count_before_cutoff IS DISTINCT FROM OLD.reschedule_free_count_before_cutoff
        OR NEW.dispute_window_hours IS DISTINCT FROM OLD.dispute_window_hours
        OR NEW.bodily_harm_window_hours IS DISTINCT FROM OLD.bodily_harm_window_hours
        OR NEW.appeal_window_hours IS DISTINCT FROM OLD.appeal_window_hours
        OR NEW.case_file_retention_days IS DISTINCT FROM OLD.case_file_retention_days
        OR NEW.legal_cap_kind IS DISTINCT FROM OLD.legal_cap_kind
        OR NEW.legal_cap_basis_points IS DISTINCT FROM OLD.legal_cap_basis_points
        OR NEW.legal_cap_amount_toman IS DISTINCT FROM OLD.legal_cap_amount_toman
        OR NEW.legal_evidence_id IS DISTINCT FROM OLD.legal_evidence_id
        OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
        OR NEW.remedy_choice_window_hours IS DISTINCT FROM OLD.remedy_choice_window_hours
        OR NEW.activation_starts_at IS DISTINCT FROM OLD.activation_starts_at
        OR NEW.activation_ends_at IS DISTINCT FROM OLD.activation_ends_at
        OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR NEW.published_by_user_id IS DISTINCT FROM OLD.published_by_user_id
        OR NEW.published_by_label IS DISTINCT FROM OLD.published_by_label
    ) THEN
        RAISE EXCEPTION 'commercial.booking_outcome_policy_versions is published and its terms are immutable: publish a new version instead'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'published' THEN
        IF NEW.published_at IS NULL OR NEW.activation_starts_at IS NULL THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions publication must set published_at and activation_starts_at'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.published_at < now() - INTERVAL '1 minute' OR NEW.published_at > now() + INTERVAL '1 minute' THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions published_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_starts_at < NEW.published_at THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot activate before it is published: an ordinary publication is never retroactive'
                USING ERRCODE = 'restrict_violation';
        END IF;
        IF NEW.activation_ends_at IS NOT NULL AND NEW.activation_ends_at <= NEW.activation_starts_at THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot be published with an activation end at or before its start'
                USING ERRCODE = 'restrict_violation';
        END IF;

        -- A published version offers at least one option per purpose; a set
        -- with nothing to choose inside is not a range, it is an absence.
        SELECT count(*) FILTER (WHERE purpose = 'late_cancellation'),
               count(*) FILTER (WHERE purpose = 'no_show')
          INTO v_late_options, v_no_show_options
          FROM commercial.booking_outcome_policy_retention_options
         WHERE version_id = NEW.id;
        IF v_late_options = 0 OR v_no_show_options = 0 THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions cannot be published without at least one retention option for each purpose'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    IF OLD.lifecycle_state = 'published' AND NEW.lifecycle_state = 'retired' THEN
        IF NEW.retired_at IS NULL
           OR NEW.retired_at < now() - INTERVAL '1 minute'
           OR NEW.retired_at > now() + INTERVAL '1 minute'
        THEN
            RAISE EXCEPTION 'commercial.booking_outcome_policy_versions retired_at must be the database clock, not a supplied instant'
                USING ERRCODE = 'restrict_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON COLUMN commercial.booking_outcome_policy_versions.remedy_choice_window_hours IS
    'V3.3 #161 (#42d), ADR-051 §8. Nullable, no ratified value or timed-wait behaviour yet: while NULL (the only state any code path interprets), the customer remedy default (full refund) executes immediately at cancellation. Frozen once the version leaves draft, like every other term on this table.';
