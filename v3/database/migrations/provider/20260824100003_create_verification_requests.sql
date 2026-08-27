-- ---------------------------------------------------------------------------
-- The verification review queue (R31-02).
--
-- `ProviderService.transitionVerification()` has existed since Phase 3: a
-- complete, CAS-hardened, event-emitting state machine with a tested
-- transition table. Its only callers were four lines in a spec file. No HTTP
-- route reached it, so every professional stayed `unverified` permanently and
-- three things downstream were permanently inert: the `verified` badge, the
-- `verifiedOnly` search filter, and `RankingConfig.WEIGHT_VERIFIED`.
--
-- This table adds the QUEUE the state machine never had -- who asked, when,
-- who decided, and why. It does NOT add states. The professional's own
-- `verification_status` column remains the single source of truth for where a
-- professional stands; a request row is the record of one review, and a
-- professional may have several over time (rejected, resubmitted, approved).
--
-- EVIDENCE IS DELIBERATELY ABSENT. Phase C introduces object storage; V3 has no
-- file-upload capability of any kind today (R31-03). Inventing an evidence URL
-- column now would either sit empty or invite someone to fill it with a
-- fabricated path. `note` carries what the professional can say in text, and
-- the boundary is documented rather than papered over.
-- ---------------------------------------------------------------------------

CREATE TABLE provider.verification_requests (
    id UUID PRIMARY KEY,

    professional_id UUID NOT NULL REFERENCES provider.professionals (id) ON DELETE CASCADE,

    -- The request's own lifecycle, which is NOT the professional's verification
    -- status. A request is pending until somebody decides it; the professional
    -- is `pending` only while that is true, and then becomes `verified` or
    -- `rejected` through the existing state machine.
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- What the professional says in support of the request. Free text, and
    -- therefore never included in any event payload or audit snapshot.
    note TEXT,

    -- Always the professional's own owner id -- the route derives it from the
    -- session and accepts no professional parameter at all.
    submitted_by UUID NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    decided_by UUID,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,

    CONSTRAINT ck_verification_request_status CHECK (status IN ('pending', 'approved', 'rejected')),
    -- A decided request has a decider and a time; a pending one has neither.
    -- Making the pairing a constraint means a half-written decision cannot
    -- exist, rather than being something every reader has to check for.
    CONSTRAINT ck_verification_request_decision CHECK (
        (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
        OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    )
);

-- At most ONE open request per professional.
--
-- A partial unique index rather than an application check: two rapid submits
-- would otherwise create two queue entries for the same professional, and an
-- operator approving one would leave the other dangling against a professional
-- who is already verified. The database makes that unrepresentable.
CREATE UNIQUE INDEX uq_verification_request_open
    ON provider.verification_requests (professional_id)
    WHERE status = 'pending';

CREATE INDEX ix_verification_requests_status ON provider.verification_requests (status, submitted_at);
