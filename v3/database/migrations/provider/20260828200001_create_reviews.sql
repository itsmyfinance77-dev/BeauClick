-- ---------------------------------------------------------------------------
-- Reviews (REVIEWS, and QA-18 as a consequence). V3.1 Phase D.
--
-- `V3_DOMAIN_BOUNDARIES.md` §provider places reviews in this schema, produced
-- as `ReviewCreated` v1 and consumed by search and loyalty, with
-- `BookingCompleted` as the eligibility input. That design is followed
-- literally; this migration is its storage.
--
-- THE ONE DESIGN DECISION WORTH READING, because it is what the two tables
-- below are for rather than one.
--
-- Phase D's security requirement is that "eligibility must be proven
-- server-side from booking data, never asserted by the client". The obvious
-- implementation is an application check: look the booking up, confirm it is
-- completed, confirm the caller is its customer, confirm no review exists.
-- Four checks, in a service, that every future caller has to remember.
--
-- Worse, provider-service CANNOT read booking-service's tables (ADR-011), so
-- that check would need a synchronous cross-domain port -- reintroducing
-- exactly the coupling `ProviderEventsService`'s docblock records V2 suffering
-- from, and making reviews undeployable without booking.
--
-- Instead, provider CONSUMES `BookingCompleted` and records its own
-- eligibility row. Two invariants then become database facts rather than
-- application checks:
--
--   * "no review without a completed booking" -- a FOREIGN KEY. A review whose
--     booking never completed has no row to point at, so it cannot be
--     inserted.
--   * "one review per completed booking" -- a UNIQUE. A second insert loses to
--     the index, not to a read-then-write that two concurrent requests can
--     both pass.
--
-- Neither is reachable by forgetting a check, and neither races.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Who may review what.
--
-- One row per completed booking, written by the `BookingCompleted` consumer.
-- `booking_id` is the PRIMARY KEY rather than a surrogate id: the event is
-- delivered at least once, and a redelivery must be a no-op. Making the
-- natural key the primary key means `ON CONFLICT DO NOTHING` is the whole
-- idempotency story -- there is no second place for a duplicate to hide.
--
-- This is a PROJECTION of a booking fact into the provider domain, not a
-- second source of truth about bookings. It carries only what eligibility
-- needs and nothing else: no price, no status, no schedule. If it disagrees
-- with booking-service about anything, booking-service is right -- but the
-- only thing it claims is "this booking completed", which is not a fact that
-- later changes.
-- ---------------------------------------------------------------------------
CREATE TABLE provider.review_eligibility (
    booking_id UUID PRIMARY KEY,

    professional_id UUID NOT NULL REFERENCES provider.professionals (id) ON DELETE CASCADE,

    -- identity.users.id, by value. No cross-schema FK, per
    -- V3_DATABASE_BLUEPRINT.md §1 -- the same convention every other
    -- cross-schema reference follows.
    customer_id UUID NOT NULL,

    service_id UUID,

    completed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Which of my completed bookings can I still review?" is the customer's own
-- question, and it is asked per customer.
CREATE INDEX ix_review_eligibility_customer ON provider.review_eligibility (customer_id, completed_at DESC);

-- ---------------------------------------------------------------------------
-- The reviews themselves.
-- ---------------------------------------------------------------------------
CREATE TABLE provider.reviews (
    id UUID PRIMARY KEY,

    -- The eligibility FK. This is the "no review without a completed booking"
    -- invariant, and it is the reason this column is NOT NULL and references
    -- the table above rather than carrying a bare booking id.
    booking_id UUID NOT NULL REFERENCES provider.review_eligibility (booking_id) ON DELETE CASCADE,

    -- Denormalized from the eligibility row at write time, never from the
    -- request. Present so the public listing and the moderation queue can
    -- filter and join without reading eligibility on every query.
    professional_id UUID NOT NULL REFERENCES provider.professionals (id) ON DELETE CASCADE,
    customer_id UUID NOT NULL,

    -- 1-5, whole numbers. A SMALLINT with a CHECK rather than a lookup table:
    -- the domain is five values that will not grow, and `search.ranking_signals`
    -- already stores `rating_sum` as an INTEGER on that assumption.
    rating SMALLINT NOT NULL,

    -- Free-text, optional. PII-ADJACENT AND EXCLUDED BY CONSTRUCTION from
    -- event payloads, audit snapshots, and any AI context
    -- (V3_DOMAIN_BOUNDARIES.md §ai names "raw review text" explicitly). The
    -- rule is recorded here, in the column that carries the data, so a future
    -- phase inherits it rather than rediscovering it.
    comment TEXT,

    status VARCHAR(16) NOT NULL DEFAULT 'published',

    -- The professional's public reply. Also free text, also never in an event.
    response_text TEXT,
    responded_at TIMESTAMPTZ,

    moderated_by UUID,
    moderated_at TIMESTAMPTZ,
    moderation_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_review_rating CHECK (rating BETWEEN 1 AND 5),
    CONSTRAINT ck_review_status CHECK (status IN ('published', 'hidden')),

    -- A reply has a time; an absent reply has neither. Making the pairing a
    -- constraint means a half-written response cannot exist, rather than being
    -- something every reader has to check for -- the same treatment
    -- `verification_requests` gives its decision columns.
    CONSTRAINT ck_review_response CHECK (
        (response_text IS NULL AND responded_at IS NULL)
        OR (response_text IS NOT NULL AND responded_at IS NOT NULL)
    ),

    -- A hidden review was hidden BY somebody, AT a time, FOR a reason. There
    -- is no such thing as a review that is hidden and unattributable: this is
    -- somebody's published opinion being removed from public view, and the
    -- audit log's row and this one must agree.
    CONSTRAINT ck_review_moderation CHECK (
        (status = 'published' OR (moderated_by IS NOT NULL AND moderated_at IS NOT NULL))
    )
);

-- One review per completed booking. The "second review" case is refused by
-- this index rather than by a read-then-write, so two concurrent submissions
-- for the same booking resolve to exactly one row.
CREATE UNIQUE INDEX uq_reviews_booking ON provider.reviews (booking_id);

-- The public profile listing: a professional's published reviews, newest first.
CREATE INDEX ix_reviews_professional_published
    ON provider.reviews (professional_id, created_at DESC)
    WHERE status = 'published';

-- The customer's own list, used to answer "have I reviewed this yet".
CREATE INDEX ix_reviews_customer ON provider.reviews (customer_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- The moderation queue.
--
-- POST-moderation, not pre-moderation, and that is forced by Phase D's own
-- Definition of Done rather than chosen for convenience: it requires
-- `review_count > 0` and `high_rating` awarded, which cannot happen if every
-- review waits for a human before it counts. A review is therefore public and
-- counted the moment it is written, and a moderator's job is to take down what
-- should not have been published.
--
-- The queue is UNTRIAGED reviews -- `moderated_at IS NULL` -- so deciding
-- either way drains it. Deciding to keep a review public is a real decision
-- that has to be recordable, otherwise the only way to clear the queue is to
-- hide things.
-- ---------------------------------------------------------------------------
CREATE INDEX ix_reviews_untriaged
    ON provider.reviews (created_at)
    WHERE moderated_at IS NULL;
