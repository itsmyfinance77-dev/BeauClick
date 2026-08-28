-- ---------------------------------------------------------------------------
-- Portfolio, profile imagery, and verification evidence (GAP-23, R31-02's
-- deferred half, V3.1 Phase C).
--
-- GAP-23 asks for `provider.portfolio_items` to be "redesigned from
-- requirements, NOT ported". V2's table carried a `file_path` string, a
-- `sort_order` integer, and no lifecycle at all -- an image was a path, and a
-- deleted image was a path that no longer resolved. Three things are
-- different here, each because of a specific V2 problem:
--
--  1. **A media id, not a path.** The bytes' location, access class, content
--     type, size, and dimensions all live in `media.objects`, which is the
--     record every read path re-authorizes against. A path column would make
--     the portfolio a second, weaker place where "is this visible" is
--     decided.
--  2. **A soft delete.** A removed portfolio item stops rendering
--     immediately, and the media object is deleted independently. V2 could
--     not distinguish "the professional removed it" from "the file went
--     missing".
--  3. **Position as a real integer with a per-professional uniqueness rule**,
--     so two items cannot claim the same slot and produce a portfolio whose
--     order changes between page loads.
--
-- The 24-June reminder that the verification migration left an explicit note
-- about evidence -- "EVIDENCE IS DELIBERATELY ABSENT. Phase C introduces
-- object storage" -- is what the third table below discharges. Nothing about
-- the verification state machine changes; evidence is an attachment to a
-- request, not a new state.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Profile imagery.
--
-- Two nullable columns rather than a separate table: a professional has at
-- most one avatar and at most one cover, and modelling a to-one as a to-many
-- means every read has to decide what "the newest of several avatars" means.
-- ---------------------------------------------------------------------------
ALTER TABLE provider.professionals
    ADD COLUMN IF NOT EXISTS avatar_media_id UUID,
    ADD COLUMN IF NOT EXISTS cover_media_id UUID;

-- ---------------------------------------------------------------------------
-- Portfolio items.
-- ---------------------------------------------------------------------------
CREATE TABLE provider.portfolio_items (
    id UUID PRIMARY KEY,

    professional_id UUID NOT NULL REFERENCES provider.professionals (id) ON DELETE CASCADE,

    -- References media.objects by value. No cross-schema foreign key, per
    -- V3_DATABASE_BLUEPRINT.md §1 -- the same convention every other
    -- cross-schema reference in V3 follows.
    media_id UUID NOT NULL,

    -- Optional, short, and free text: it is displayed publicly, so it carries
    -- the same "never in an event payload" treatment the verification note has.
    caption VARCHAR(200),

    -- Explicit ordering. Without it the portfolio's order is whatever the
    -- planner returns, which is stable right up until it is not.
    position INT NOT NULL,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,

    CONSTRAINT ck_portfolio_position CHECK (position >= 0)
);

-- One media object may back at most one LIVE portfolio item. Without this, a
-- professional could add the same upload twice and see it twice in their own
-- gallery -- and deleting one item would delete the shared object's bytes out
-- from under the other.
CREATE UNIQUE INDEX uq_portfolio_media_live
    ON provider.portfolio_items (media_id)
    WHERE deleted_at IS NULL;

-- One item per slot per professional, among live items.
CREATE UNIQUE INDEX uq_portfolio_position_live
    ON provider.portfolio_items (professional_id, position)
    WHERE deleted_at IS NULL;

CREATE INDEX ix_portfolio_professional_live
    ON provider.portfolio_items (professional_id, position)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Verification evidence.
--
-- The attachment the verification queue was built without, and said so.
--
-- SECURITY, because this is the table that makes `V3_SECURITY_MODEL.md` §8
-- real rather than aspirational: the media objects referenced here are
-- created with `access_class = 'protected'`, which means they have no public
-- URL at all -- not an unlisted one, not a hard-to-guess one. The only route
-- to their bytes re-checks, on every request, that the caller is either the
-- submitter or currently holds `bc_moderate_verification`.
--
-- Evidence is attached to a REQUEST, not to a professional. A rejected
-- request's evidence stays bound to the request that was rejected, so a
-- resubmission is a new request with its own evidence and a moderator can see
-- what was submitted the first time.
-- ---------------------------------------------------------------------------
CREATE TABLE provider.verification_request_evidence (
    id UUID PRIMARY KEY,

    request_id UUID NOT NULL REFERENCES provider.verification_requests (id) ON DELETE CASCADE,

    media_id UUID NOT NULL,

    -- Always the submitting professional's own owner id -- the route derives
    -- it from the session and accepts no professional parameter.
    uploaded_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One media object backs at most one evidence row.
CREATE UNIQUE INDEX uq_verification_evidence_media ON provider.verification_request_evidence (media_id);

CREATE INDEX ix_verification_evidence_request ON provider.verification_request_evidence (request_id);
