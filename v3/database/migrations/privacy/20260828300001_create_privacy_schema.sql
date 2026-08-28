-- ---------------------------------------------------------------------------
-- Privacy: self-service export, erasure, and the erasure grace window.
-- V3.1 Phase E. Closes GAP-22 and GAP-21.
--
-- `V3_DOMAIN_BOUNDARIES.md` §admin/privacy fixes both the shape and the
-- boundary: privacy is "**not a data-owning service**" in the domain sense --
-- it owns no user data of its own, only the REQUESTS -- and its schema is
-- "`privacy` -- `data_requests` (single table for both export and deletion
-- request lifecycles, preserved from V2's proven shape)". That is what this
-- migration creates, plus one table V2 did not have and needed.
--
-- WHY TWO TABLES RATHER THAN ONE.
--
-- V2 kept the export payload on the request row. That is convenient and it is
-- the wrong shape here, because the two have completely different exposure:
--
--   * `data_requests` is administratively visible. `GET /v1/admin/privacy/
--     requests` lists it, because an operator has to be able to answer "is
--     this user's deletion actually progressing" without being able to read
--     what the user's data IS.
--   * `export_payloads` is visible to exactly one principal in the entire
--     system -- the subject -- and to nobody else, ever. V3.1's Phase E
--     security note states it without qualification: "No admin route may ever
--     download another user's export file."
--
-- Separating them makes that a structural property rather than a `SELECT`
-- somebody has to remember not to write. An admin route reading
-- `data_requests` cannot accidentally return a payload, because the payload
-- is not in the row it read.
--
-- WHY ERASURE HAS A GRACE WINDOW (GAP-21).
--
-- Deletion is the one irreversible action a user can take against their own
-- account, and it is routinely taken in anger or by mistake. `execute_after`
-- is the window; `POST /v1/privacy/deletion/:id/cancel` is the way back. And
-- the window is what makes "cancel fully restores the account" TRUE by
-- construction rather than by a restore procedure: nothing has been destroyed
-- yet, so there is nothing to restore. A design that erased immediately and
-- kept a backup to undo from would have to keep the erased data around to
-- honour the undo, which defeats the erasure.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS privacy;

-- ---------------------------------------------------------------------------
-- One row per request, for both lifecycles.
-- ---------------------------------------------------------------------------
CREATE TABLE privacy.data_requests (
    id UUID PRIMARY KEY,

    -- identity.users.id, by value. No cross-schema FK, per
    -- V3_DATABASE_BLUEPRINT.md §1 -- and here there is a second reason: the
    -- request must outlive the erasure it records. An ON DELETE CASCADE would
    -- delete the proof that the platform honoured the request at the exact
    -- moment the proof started mattering.
    subject_user_id UUID NOT NULL,

    kind VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,

    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Erasure only. The earliest moment the sweep may execute this request.
    execute_after TIMESTAMPTZ,

    -- Export only. When the generated document stops being downloadable and
    -- its payload row is destroyed.
    expires_at TIMESTAMPTZ,

    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,

    -- Who cancelled. The subject, always -- there is deliberately no
    -- administrative cancel route, because an operator who can cancel a
    -- deletion can silently keep an account the user asked to be rid of.
    cancelled_by UUID,

    -- A stable code, never a raw error string. The same rule
    -- `NotificationChannelPort.errorCode` records: a driver's message
    -- routinely embeds the very data this row must not carry.
    failure_code VARCHAR(64),

    -- What erasure actually did, per module: counts and retention reasons.
    -- NEVER the erased content itself. This is the compliance record -- it has
    -- to survive to prove the erasure happened, so it must contain nothing
    -- that erasure was supposed to destroy.
    outcome JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_privacy_request_kind CHECK (kind IN ('export', 'erasure')),
    CONSTRAINT ck_privacy_request_status CHECK (
        status IN ('pending', 'processing', 'ready', 'completed', 'cancelled', 'expired', 'failed')
    ),

    -- An erasure request has a window; an export has an eventual expiry and no
    -- window. Encoding which column belongs to which lifecycle as a constraint
    -- means a request cannot exist in a shape no code path knows how to
    -- handle, which is what a single table for two lifecycles otherwise risks.
    CONSTRAINT ck_privacy_request_window CHECK (
        (kind = 'erasure' AND execute_after IS NOT NULL)
        OR (kind = 'export' AND execute_after IS NULL)
    ),

    -- A cancellation has a time and an actor, or there is no cancellation.
    -- Same treatment `provider.reviews` gives its moderation columns, for the
    -- same reason: there is no such thing as an unattributable one.
    CONSTRAINT ck_privacy_request_cancellation CHECK (
        (cancelled_at IS NULL AND cancelled_by IS NULL)
        OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    ),

    -- A cancelled request is cancelled. Without this, `status = 'cancelled'`
    -- and `cancelled_at IS NULL` is representable, and the sweep -- which
    -- selects on status -- and the API -- which shows the timestamp -- would
    -- disagree about the same row.
    CONSTRAINT ck_privacy_request_cancelled_status CHECK (
        (status <> 'cancelled') OR (cancelled_at IS NOT NULL)
    )
);

-- ---------------------------------------------------------------------------
-- At most one request of each kind in flight per subject.
--
-- A partial UNIQUE rather than a check in the service, because the failure
-- mode is concurrent: two taps on "delete my account" arrive together, both
-- read no open request, and both insert. Two erasure requests for one subject
-- means the second one executes against an already-erased account and either
-- fails or -- worse -- succeeds and records a second, meaningless compliance
-- row. The index refuses the loser.
--
-- `processing` is included: a request the sweep has claimed is still in
-- flight, and letting a second one queue up behind it would produce exactly
-- the same double execution one moment later.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_privacy_open_request_per_subject
    ON privacy.data_requests (subject_user_id, kind)
    WHERE status IN ('pending', 'processing');

-- The subject's own list, newest first.
CREATE INDEX ix_privacy_requests_subject ON privacy.data_requests (subject_user_id, requested_at DESC);

-- The administrative queue: everything still in flight, oldest first, so the
-- tail is reachable. Same ordering choice the verification and review queues
-- make, for the same reason.
CREATE INDEX ix_privacy_requests_open
    ON privacy.data_requests (requested_at)
    WHERE status IN ('pending', 'processing');

-- What the sweep scans. Two partial indexes rather than one, because the sweep
-- asks two different questions and a single index on `status` would make both
-- of them scan every finished request forever.
CREATE INDEX ix_privacy_erasures_due
    ON privacy.data_requests (execute_after)
    WHERE kind = 'erasure' AND status = 'pending';

CREATE INDEX ix_privacy_exports_expiring
    ON privacy.data_requests (expires_at)
    WHERE kind = 'export' AND status = 'ready';

-- ---------------------------------------------------------------------------
-- The generated export document.
--
-- One row per completed export, in its own table for the exposure reason at
-- the top of this file, and with `ON DELETE CASCADE` so a destroyed request
-- can never leave an orphaned copy of somebody's personal data behind. This is
-- the one cascade in the schema and it deletes in the safe direction.
--
-- `document` is the whole export as JSONB. Bounded by what one subject can
-- accumulate -- their own bookings, orders, reviews, notifications -- which is
-- kilobytes, not gigabytes. It is deliberately NOT in object storage: the S3
-- driver hands out presigned URLs, and a presigned URL to a complete personal-
-- data export is a bearer credential that survives being forwarded, logged by
-- a proxy, or left in a browser's history. Serving it through an authenticated
-- route means the subject's session is re-verified on every single byte
-- delivered, which is the property Phase E's security note actually asks for.
-- ---------------------------------------------------------------------------
CREATE TABLE privacy.export_payloads (
    request_id UUID PRIMARY KEY REFERENCES privacy.data_requests (id) ON DELETE CASCADE,

    document JSONB NOT NULL,

    -- Reported to the subject alongside the download so an interrupted
    -- transfer is detectable by the client rather than silently truncated.
    byte_size BIGINT NOT NULL,
    checksum_sha256 CHAR(64) NOT NULL,

    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_privacy_payload_size CHECK (byte_size > 0)
);

-- ---------------------------------------------------------------------------
-- The outbox. Same shape as every other schema's, drained by the same relay.
-- ---------------------------------------------------------------------------
CREATE TABLE privacy.outbox_events (
    id UUID PRIMARY KEY,
    aggregate_type VARCHAR(60) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(80) NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    correlation_id UUID,
    published_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_privacy_outbox_unpublished ON privacy.outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX ix_privacy_outbox_correlation_id ON privacy.outbox_events (correlation_id);
