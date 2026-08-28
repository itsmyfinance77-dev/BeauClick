-- ---------------------------------------------------------------------------
-- Object storage's persistent half (R31-03, V3.1 Phase C).
--
-- WHAT THIS TABLE IS. Not a file index -- an AUTHORIZATION RECORD. The bytes
-- live in an object store; this row is what every read path consults to
-- decide whether the caller may have them. `V3_SECURITY_MODEL.md` §8 requires
-- that access control for a private file be re-checked "on every single
-- request", and that is only possible if there is somewhere to check. This is
-- that somewhere.
--
-- `access_class` is the column the whole model turns on. It is denormalized
-- from `MEDIA_POLICY[purpose]` AT CREATION rather than derived at read time,
-- so that a later policy edit -- someone deciding portfolio images should be
-- protected, or worse, that evidence should not be -- cannot retroactively
-- change the class of objects already stored. A stored object's class is a
-- fact about it, not a lookup.
--
-- WHY THERE IS NO CROSS-SCHEMA FOREIGN KEY to identity.users or to
-- provider.professionals: the same convention every other V3 schema follows
-- (V3_DATABASE_BLUEPRINT.md §1). `owner_user_id` references identity by
-- value.
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS media;

CREATE TABLE media.objects (
    id UUID PRIMARY KEY,

    -- Always the authenticated session's own id. No media route accepts an
    -- owner parameter, so this can only ever be the uploader.
    owner_user_id UUID NOT NULL,

    purpose VARCHAR(32) NOT NULL,
    access_class VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending',

    -- Which driver wrote it. A deployment that migrates from `local` to `s3`
    -- must not silently address old keys through the new driver and serve
    -- 404s that look like deletions.
    storage_driver VARCHAR(16) NOT NULL,
    storage_key TEXT NOT NULL,

    -- What the client CLAIMED on the way in. Kept for diagnostics and never
    -- used as truth: `content_type` below is what the bytes actually are.
    declared_content_type VARCHAR(100) NOT NULL,
    declared_byte_size BIGINT NOT NULL,

    -- Written only by finalize, from a server-side sniff of the stored object.
    content_type VARCHAR(100),
    byte_size BIGINT,

    -- Intrinsic pixel dimensions, captured at finalize.
    --
    -- These are not metadata for its own sake. Phase C's one measurable
    -- Definition-of-Done item is "renders with zero layout shift", and a
    -- browser cannot reserve space for an image whose aspect ratio it learns
    -- only when the bytes arrive. Persisting the dimensions is what lets every
    -- later surface set an explicit ratio without measuring anything.
    width INT,
    height INT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finalized_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,

    -- Set when a moderator removed it, so a takedown is distinguishable from
    -- the owner deleting their own work. Both end as `deleted`; only one of
    -- them is somebody else's decision.
    taken_down_by UUID,

    CONSTRAINT ck_media_object_status CHECK (status IN ('pending', 'stored', 'deleted')),
    CONSTRAINT ck_media_object_access_class CHECK (access_class IN ('public', 'protected')),
    CONSTRAINT ck_media_object_purpose CHECK (
        purpose IN ('portfolio', 'avatar', 'cover', 'verification_evidence')
    ),

    -- A `stored` object has been measured; a `pending` one has not. Making
    -- the pairing a constraint means a half-finalized object -- published but
    -- with no known content type or size -- cannot exist, rather than being
    -- something every reader has to defend against.
    CONSTRAINT ck_media_object_finalized CHECK (
        (status <> 'stored')
        OR (finalized_at IS NOT NULL AND content_type IS NOT NULL AND byte_size IS NOT NULL
            AND width IS NOT NULL AND height IS NOT NULL)
    ),

    CONSTRAINT ck_media_object_dimensions CHECK (
        (width IS NULL AND height IS NULL) OR (width > 0 AND height > 0)
    )
);

-- One row per object key, enforced by the database rather than by the key
-- generator's promise. Two rows claiming the same key would mean deleting one
-- silently deletes the other's bytes.
CREATE UNIQUE INDEX uq_media_objects_storage_key ON media.objects (storage_key);

-- Quota is counted per (owner, purpose, status='stored') on the grant path,
-- and pending grants per (owner, status='pending'). One index serves both.
CREATE INDEX ix_media_objects_owner_purpose_status ON media.objects (owner_user_id, purpose, status);

-- The reaper's query: pending rows older than the grant TTL.
CREATE INDEX ix_media_objects_pending_created ON media.objects (created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Abuse reports.
--
-- The one path by which a human says an image that passed every automated
-- check should still come down. Content-type sniffing, size caps, and quota
-- all constrain what ARRIVES; this is the only control over what should not
-- have.
--
-- Only PUBLIC objects are reportable, enforced in the service rather than
-- here because the check needs the object's row: accepting a report against a
-- protected id would confirm to the reporter that an id they cannot see
-- exists.
-- ---------------------------------------------------------------------------
CREATE TABLE media.abuse_reports (
    id UUID PRIMARY KEY,

    media_object_id UUID NOT NULL REFERENCES media.objects (id) ON DELETE CASCADE,

    -- The reporting session's own user id, never accepted from the body.
    reported_by UUID NOT NULL,
    reason VARCHAR(32) NOT NULL,
    -- Free text from the reporter. Never enters an event payload or an audit
    -- snapshot, for the same reason the verification note does not.
    note TEXT,

    status VARCHAR(16) NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    decided_by UUID,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,

    CONSTRAINT ck_media_report_status CHECK (status IN ('open', 'upheld', 'rejected')),
    CONSTRAINT ck_media_report_reason CHECK (
        reason IN ('not_own_work', 'explicit', 'misleading', 'personal_data', 'other')
    ),
    -- Same pairing constraint the verification queue uses: a decided report
    -- has a decider and a time, an open one has neither.
    CONSTRAINT ck_media_report_decision CHECK (
        (status = 'open' AND decided_by IS NULL AND decided_at IS NULL)
        OR (status <> 'open' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    )
);

-- One OPEN report per (object, reporter). A partial unique index rather than
-- an application check: without it, a single user can file the same complaint
-- repeatedly and inflate a queue a moderator has to read.
CREATE UNIQUE INDEX uq_media_report_open_per_reporter
    ON media.abuse_reports (media_object_id, reported_by)
    WHERE status = 'open';

CREATE INDEX ix_media_reports_status_created ON media.abuse_reports (status, created_at);
