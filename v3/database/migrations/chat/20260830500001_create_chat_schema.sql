-- V3.2-B, chat-service. Internal human messaging, to the externally-independent
-- backend milestone (ADR-031, ADR-032).
--
-- Every number here is an owner decision recorded in `V3.2_DECISION_REGISTER.md`
-- §B on 2026-08-30: a 90-day send window (`V32-DEC-012`), 24-month retention
-- (`V32-DEC-013`), 5 reports per reporter per 24 hours and a 500-code-point note
-- (`V32-DEC-014`), a 50-message moderator window (`V32-DEC-015`).
--
-- ## The defect this schema exists to not repeat
--
-- V2's chat had NO eligibility rule. `start_or_get` rejected exactly two things:
-- a conversation with yourself, and a non-positive id. Any logged-in holder of
-- `bc_send_message` could open a thread against any user id in the platform --
-- a harassment surface and a user-enumeration oracle in one function.
--
-- So the load-bearing column in this file is `counterparty_id`, and the
-- load-bearing property is that it is IMMUTABLE and DERIVED. It is copied once
-- from the historical seller-party snapshot on the booking's commerce order and
-- never recomputed. A professional who changes salon does not drag a customer's
-- existing conversation to a business that customer never dealt with, because
-- nothing recomputes it -- not because a service remembers not to.
--
-- ## What is deliberately absent
--
-- **No `message_attachments` table.** Attachments are out of this milestone
-- entirely (`CHAT-ATTACHMENT-STORAGE`), and a table nothing writes would still
-- have to be claimed for subject-data coverage -- a claim nobody can verify.
-- Adding them later is a child table plus a `MessageSent` v2.
--
-- **No `deleted_at` anywhere.** `V32-DEC-013` sweeps by hard delete and cascade.
-- A soft-delete column would make the retention claim false, and there is
-- nowhere to record one even if somebody wanted to.
--
-- ## Column naming is a privacy control, not a style choice
--
-- ADR-027's boot-time coverage check rejects a `no_subject_data` claim on any
-- table carrying a subject-shaped column -- but it recognises only the names
-- `user_id`, `customer_id`, `owner_id`, `actor_id`, `subject_id`, `phone`,
-- `email` and the suffixes `_by` and `_user_id`. The obvious chat names --
-- `participant_a_id`, `sender_id`, `blocker_id`, `blocked_id` -- match NONE of
-- them, so a table using them could be mis-claimed and waved through.
--
-- Every identity column below therefore ends in `_user_id`. That costs nothing
-- and closes the one gap `coverage.ts` documents as its residual risk. The
-- dispositions are still declared explicitly and proved by test; the naming is
-- belt, not braces.

CREATE SCHEMA IF NOT EXISTS chat;

-- --------------------------------------------------------------------------
-- One conversation per (customer, immutable counterparty).
-- --------------------------------------------------------------------------
CREATE TABLE chat.conversations (
    id UUID PRIMARY KEY,

    -- The customer side. Always resolved from the authenticated session; no
    -- route anywhere accepts this value from a caller.
    customer_user_id UUID NOT NULL,

    /*
     * The seller side, as it was AT CHECKOUT.
     *
     * Copied from `commerce.orders.seller_party_type/seller_party_id` for a
     * qualifying booking, and never recomputed. `SellerPartyLookup` computes the
     * CURRENT party and is deliberately not used here: current affiliation
     * changes when a professional moves salon, and using it would move an
     * existing conversation to a business the customer never transacted with.
     *
     * `professional` means an independent professional's id; `business` means a
     * business id -- never a staff user id. Reuses commerce's existing
     * two-value party vocabulary rather than inventing a second one.
     */
    counterparty_type VARCHAR(16) NOT NULL,
    counterparty_id UUID NOT NULL,

    status VARCHAR(16) NOT NULL DEFAULT 'open',

    -- Maintained inside the send transaction. Denormalized because the inbox is
    -- the landing surface and a per-row count there is a correlated subquery on
    -- the largest table in the schema.
    message_count INTEGER NOT NULL DEFAULT 0,

    -- The monotonic sequence high-water mark. Allocated under this row's lock;
    -- see `chat.messages`.
    last_sequence INTEGER NOT NULL DEFAULT 0,

    -- Retention is measured from here (`V32-DEC-013`), and the inbox is ordered
    -- by it. NULL until the first message, so an abandoned empty conversation
    -- still ages out on `created_at`.
    last_message_at TIMESTAMPTZ,

    /*
     * Set by an upheld moderation decision that closes the conversation, or by
     * either participant's block. Sending is refused while non-null; reading is
     * unaffected -- `V32-DEC-014` keeps history readable after a block, because
     * destroying the past would let one party unilaterally erase a record the
     * other may need.
     */
    closed_for_sending_at TIMESTAMPTZ,
    closed_reason VARCHAR(24),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_chat_conversations_counterparty_type
        CHECK (counterparty_type IN ('professional', 'business')),
    CONSTRAINT ck_chat_conversations_status CHECK (status IN ('open', 'closed')),
    CONSTRAINT ck_chat_conversations_closed_reason CHECK (
        closed_reason IS NULL OR closed_reason IN ('moderation', 'blocked')
    ),
    CONSTRAINT ck_chat_conversations_closed_consistently CHECK (
        (closed_for_sending_at IS NULL AND closed_reason IS NULL)
        OR (closed_for_sending_at IS NOT NULL AND closed_reason IS NOT NULL)
    ),
    CONSTRAINT ck_chat_conversations_counts CHECK (message_count >= 0 AND last_sequence >= 0),

    -- `V32-DEC-011`: many qualifying bookings collapse into ONE conversation per
    -- immutable counterparty. Ten appointments with one salon is one thread; a
    -- per-booking thread would scatter a relationship across a list.
    CONSTRAINT uq_chat_conversations_pair
        UNIQUE (customer_user_id, counterparty_type, counterparty_id)
);

-- The target of every child table's composite foreign key. Makes "this row
-- belongs to the same customer as its conversation" a guarantee the DATABASE
-- holds, rather than a WHERE clause somebody has to remember -- the property
-- that removed an entire bug class from the `ai` schema in V3.2-A.
ALTER TABLE chat.conversations
    ADD CONSTRAINT uq_chat_conversations_id_customer UNIQUE (id, customer_user_id);

CREATE INDEX ix_chat_conversations_customer
    ON chat.conversations (customer_user_id, last_message_at DESC NULLS LAST, id DESC);

-- The seller-side inbox: every conversation for one counterparty.
CREATE INDEX ix_chat_conversations_counterparty
    ON chat.conversations (counterparty_type, counterparty_id, last_message_at DESC NULLS LAST, id DESC);

-- The retention sweep reads exactly this.
CREATE INDEX ix_chat_conversations_retention
    ON chat.conversations (last_message_at NULLS FIRST);

-- --------------------------------------------------------------------------
-- Who may read a conversation, and how far they have read.
-- --------------------------------------------------------------------------
--
-- A row per (conversation, reader). The customer gets one at creation; on the
-- seller side a row is created lazily the first time an authorized reader --
-- the independent professional's owner, or a business owner/active manager --
-- actually opens the thread.
--
-- Read state is a WATERMARK here, not a `read_at` on the message. V2 used the
-- per-message column, which is correct for exactly two participants and wrong
-- for three (`F-07`), and a business-side conversation already has more than one
-- legitimate reader on day one. This is not speculative generality.
CREATE TABLE chat.conversation_participants (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,

    -- Denormalized customer id, so the composite FK below can hold.
    customer_user_id UUID NOT NULL,

    participant_user_id UUID NOT NULL,

    -- Which side this reader sits on. `customer` is the conversation's own
    -- customer; `seller` is anyone currently authorized on the counterparty side.
    side VARCHAR(16) NOT NULL,

    /*
     * Monotonic. Only ever increases -- a client reporting a lower value is
     * ignored rather than obeyed, because a watermark that can go backwards is a
     * way to make somebody else's unread badge reappear.
     */
    last_read_sequence INTEGER NOT NULL DEFAULT 0,
    last_read_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_chat_participants_side CHECK (side IN ('customer', 'seller')),
    CONSTRAINT ck_chat_participants_watermark CHECK (last_read_sequence >= 0),

    CONSTRAINT fk_chat_participants_conversation
        FOREIGN KEY (conversation_id, customer_user_id)
        REFERENCES chat.conversations (id, customer_user_id) ON DELETE CASCADE,

    -- A user appears at most once per conversation.
    CONSTRAINT uq_chat_participants_conversation_user
        UNIQUE (conversation_id, participant_user_id)
);

CREATE INDEX ix_chat_participants_user ON chat.conversation_participants (participant_user_id);

-- --------------------------------------------------------------------------
-- Messages. Subject-authored prose lives here and nowhere else.
-- --------------------------------------------------------------------------
CREATE TABLE chat.messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    customer_user_id UUID NOT NULL,

    /*
     * Who wrote it.
     *
     * NULL only for a structural placeholder left behind by account erasure --
     * see `body` and `erased_at` below. A NULL sender is what a tombstoned
     * participant looks like; no moderator-authored row can ever exist, because
     * a moderator is never a participant.
     */
    sender_user_id UUID,

    /*
     * The message text.
     *
     * `V32-DEC-013`, the ADR-027-CONSISTENT option: on account erasure this is
     * set to NULL and `erased_at` is stamped. The row survives so the surviving
     * counterparty's own messages keep their sequence and read as a
     * conversation; the PROSE does not.
     *
     * A NULL body carries no original body, no excerpt, no searchable text, and
     * nothing reconstructable. It is a gap with a sequence number, not a
     * redaction of a known string -- there is no ciphertext, no hash, and no
     * length preserved.
     *
     * Stored HERE and in no event payload, notification payload, analytics
     * dimension, metric label, or log line (ADR-032 §5).
     */
    body TEXT,

    -- Stamped exactly when `body` is NULL. The pairing is a CHECK, so a row
    -- cannot claim to be erased while still holding text, or hold no text
    -- without saying why.
    erased_at TIMESTAMPTZ,

    -- Monotonic within the conversation, allocated under the conversation row's
    -- lock. Ordering is by this, never by a client timestamp.
    sequence INTEGER NOT NULL,

    /*
     * Client-supplied, so a retried POST returns the original message instead of
     * creating a second one. Scoped by (conversation, sender) rather than
     * globally, for the reason `booking.idempotency_keys` records: a
     * globally-unique key lets one user's key collide with another's, and a
     * collision there returns the OTHER user's row.
     */
    idempotency_key VARCHAR(128),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_chat_messages_sequence CHECK (sequence > 0),
    CONSTRAINT ck_chat_messages_body_bounded CHECK (body IS NULL OR length(body) <= 8000),
    CONSTRAINT ck_chat_messages_body_not_blank CHECK (body IS NULL OR length(btrim(body)) > 0),
    -- Erasure is all-or-nothing: no body and a stamp, or a body and no stamp.
    CONSTRAINT ck_chat_messages_erasure_paired CHECK (
        (body IS NULL AND erased_at IS NOT NULL) OR (body IS NOT NULL AND erased_at IS NULL)
    ),
    -- An erased row has no author; a live row always does.
    CONSTRAINT ck_chat_messages_sender_paired CHECK (
        (erased_at IS NOT NULL) OR (sender_user_id IS NOT NULL)
    ),

    CONSTRAINT fk_chat_messages_conversation
        FOREIGN KEY (conversation_id, customer_user_id)
        REFERENCES chat.conversations (id, customer_user_id) ON DELETE CASCADE,

    CONSTRAINT uq_chat_messages_sequence UNIQUE (conversation_id, sequence),
    CONSTRAINT uq_chat_messages_id_customer UNIQUE (id, customer_user_id)
);

-- Keyset pagination reads this. V2 used offset and had to fix an unbounded list
-- twice.
CREATE INDEX ix_chat_messages_conversation_sequence
    ON chat.messages (conversation_id, sequence DESC);

-- The subject-data export reads every message one person wrote.
CREATE INDEX ix_chat_messages_sender ON chat.messages (sender_user_id, created_at);

-- Idempotent send. Partial, because most rows carry no key and a full index
-- would be mostly NULLs.
CREATE UNIQUE INDEX uq_chat_messages_idempotency
    ON chat.messages (conversation_id, sender_user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND sender_user_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Blocks. Directional record, mutual effect.
-- --------------------------------------------------------------------------
--
-- `V32-DEC-014`. The RECORD is directional because moderation needs to answer
-- "who blocked whom" and a symmetric row cannot. The EFFECT is mutual because a
-- one-way block leaves the blocker free to keep messaging somebody who has
-- signalled they want no contact -- the harassment case with the roles reversed.
--
-- The blocked party is never told. A block notification is an invitation to
-- retaliate through a channel the platform does not control.
CREATE TABLE chat.blocks (
    id UUID PRIMARY KEY,
    blocker_user_id UUID NOT NULL,
    blocked_user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_chat_blocks_not_self CHECK (blocker_user_id <> blocked_user_id),
    CONSTRAINT uq_chat_blocks_pair UNIQUE (blocker_user_id, blocked_user_id)
);

-- The send path asks "does a block exist in EITHER direction between these two",
-- so both orderings need an index.
CREATE INDEX ix_chat_blocks_blocked ON chat.blocks (blocked_user_id, blocker_user_id);

-- --------------------------------------------------------------------------
-- Reports. Mirrors `media.abuse_reports` rather than inventing a second model.
-- --------------------------------------------------------------------------
CREATE TABLE chat.reports (
    id UUID PRIMARY KEY,

    conversation_id UUID NOT NULL,
    customer_user_id UUID NOT NULL,

    /*
     * The specific message complained about.
     *
     * Required: without an anchor a moderator reads a thread looking for the
     * complaint; with one they read the complaint. It is also what centres the
     * 50-message window `V32-DEC-015` bounds them to.
     *
     * ON DELETE SET NULL rather than CASCADE: an erasure that removes the
     * anchored message must not silently destroy an open moderation record.
     * The report survives, pointing at nothing, which is the honest state.
     *
     * A SINGLE-column foreign key, unlike every other reference in this schema.
     * The composite form would have to null BOTH columns on delete, and
     * `customer_user_id` is NOT NULL -- so `ON DELETE SET NULL` on a composite
     * key is unsatisfiable and PostgreSQL refuses it. Ownership is already
     * pinned by the conversation FK below, so nothing is lost.
     */
    message_id UUID,

    -- The reporter. Tombstoned rather than removed on erasure, consistent with
    -- the admin audit log: a privileged decision must stay attributable, or the
    -- trail is defeated by the subject of a complaint closing their account.
    reported_by UUID,

    reason VARCHAR(32) NOT NULL,

    /*
     * Optional free text, capped at 500 Unicode code points by the application.
     *
     * Moderation prose. Never enters an event, a notification, an analytics
     * dimension, a metric label, or a log line (ADR-032 §3). The CHECK here is a
     * backstop against a grossly wrong write, not the product rule -- PostgreSQL
     * `length()` counts characters, not code points, so a column cap would be a
     * second, subtly different limit.
     */
    note TEXT,

    status VARCHAR(16) NOT NULL DEFAULT 'open',

    decided_by UUID,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,
    -- What an upheld decision actually did. NULL on `rejected`.
    decision_action VARCHAR(24),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_chat_report_status CHECK (status IN ('open', 'upheld', 'rejected')),
    CONSTRAINT ck_chat_report_reason CHECK (
        reason IN ('harassment', 'spam', 'scam_or_fraud', 'explicit',
                   'personal_data', 'off_platform_payment', 'other')
    ),
    CONSTRAINT ck_chat_report_note_bounded CHECK (note IS NULL OR length(note) <= 2000),
    CONSTRAINT ck_chat_report_action CHECK (
        decision_action IS NULL
        OR decision_action IN ('warn_sender', 'close_conversation', 'restrict_sender')
    ),
    -- A decided report has a decider and a time; an open one has neither. The
    -- same pairing `media.abuse_reports` enforces.
    CONSTRAINT ck_chat_report_decision CHECK (
        (status = 'open' AND decided_by IS NULL AND decided_at IS NULL AND decision_action IS NULL)
        OR (status <> 'open' AND decided_at IS NOT NULL)
    ),
    -- Only an upheld report may carry an action.
    CONSTRAINT ck_chat_report_action_only_when_upheld CHECK (
        decision_action IS NULL OR status = 'upheld'
    ),

    CONSTRAINT fk_chat_reports_conversation
        FOREIGN KEY (conversation_id, customer_user_id)
        REFERENCES chat.conversations (id, customer_user_id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_reports_message
        FOREIGN KEY (message_id) REFERENCES chat.messages (id) ON DELETE SET NULL
);

-- Reports CASCADE with their conversation, deliberately.
--
-- The 24-month retention sweep destroys a conversation and everything under it,
-- reports included. That is not a loss of the moderation record: an upheld or
-- rejected decision is written to `admin.admin_audit_log`, which the application
-- role cannot UPDATE or DELETE and which no sweep touches. The report row is the
-- working queue item; the audit row is the permanent record.

-- One OPEN report per reporter per conversation. A partial unique index rather
-- than an application check, for the reason `media.abuse_reports` records:
-- without it a single user can file the same complaint repeatedly and inflate a
-- queue a moderator has to read.
CREATE UNIQUE INDEX uq_chat_report_open_per_reporter
    ON chat.reports (reported_by, conversation_id)
    WHERE status = 'open' AND reported_by IS NOT NULL;

-- The moderation queue: open reports, oldest first.
CREATE INDEX ix_chat_reports_status_created ON chat.reports (status, created_at);

-- The 5-per-24-hours rate limit counts this.
CREATE INDEX ix_chat_reports_reporter_created ON chat.reports (reported_by, created_at);

-- --------------------------------------------------------------------------
-- Send throttle counters (`V32-DEC-014` abuse control).
-- --------------------------------------------------------------------------
--
-- Why a table and not the HTTP throttler: `BeauClickThrottlerGuard`'s storage is
-- in-memory per process, which is correct at single-instance scale and silently
-- wrong the moment a second instance exists -- the effective limit multiplies by
-- instance count. That topology question is `THROTTLE-STORE` and it is
-- unresolved. A PostgreSQL row is shared across every instance by construction.
--
-- Why a BUCKET column rather than a rolling window: a single counter row per
-- user rewritten on every send becomes a contention point on the busiest table
-- in the schema. Bucketing by minute means concurrent senders in different
-- minutes touch different rows, and the conditional increment only ever
-- serialises senders inside the same minute -- which is exactly the set the
-- limit is about.
CREATE TABLE chat.send_counters (
    user_id UUID NOT NULL,
    -- The minute this bucket covers, truncated. UTC; this is a rate limit, not a
    -- promise about anybody's calendar day.
    window_start TIMESTAMPTZ NOT NULL,
    sent_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, window_start),
    CONSTRAINT ck_chat_send_counters_count CHECK (sent_count >= 0)
);

-- The sweep that reaps stale buckets.
CREATE INDEX ix_chat_send_counters_window ON chat.send_counters (window_start);

-- --------------------------------------------------------------------------
-- The transactional outbox.
-- --------------------------------------------------------------------------
--
-- Identical in shape to every other schema's. What differs is what may travel in
-- `payload`: ids, enums, counts, and instants only. The chat event contracts
-- have no field able to hold a message body or a report note, which is the same
-- discipline `notification` applies to message bodies, `journey` to goal titles,
-- and `ai` to prompts.
CREATE TABLE chat.outbox_events (
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

CREATE INDEX ix_chat_outbox_unpublished ON chat.outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX ix_chat_outbox_correlation ON chat.outbox_events (correlation_id);
