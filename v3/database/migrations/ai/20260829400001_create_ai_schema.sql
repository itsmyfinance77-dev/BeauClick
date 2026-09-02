-- V3.2-A, ai-service. The AI assistant foundation, to the deterministic
-- sandbox milestone (ADR-029, ADR-030).
--
-- Every number in this file is an owner decision recorded in
-- `V3.2_DECISION_REGISTER.md` on 2026-08-29, not an engineering default:
-- 24-hour inactivity closure and 30-day retention (`V32-DEC-002`,
-- `V32-DEC-007`), 20 retained conversations per customer (`V32-DEC-002`), and
-- 20 accepted messages per Tehran calendar day (`V32-DEC-008`).
--
-- ## The shape, and the shape it deliberately is not
--
-- V2 kept one conversation per user, keyed `UNIQUE(user_id)`, and V3's own
-- migration matrix records that as `GAP-12` -- revisit, do not re-adopt. The
-- defect is not usability. An accumulating single thread is an unbounded
-- prompt, an unbounded retention obligation, and an unbounded injection
-- surface, because text a customer typed six months ago is still being replayed
-- to a provider today. So there is no unique key on `user_id` here, and there
-- is a `status` and a `last_activity_at` instead: conversations are BOUNDED
-- SESSIONS, finite by construction rather than by a sweep somebody has to
-- remember to build.
--
-- Professional mode is absent entirely (`V32-DEC-001`). When it is approved it
-- gets its own table keyed on the party, NOT a `scope` column here -- V2's own
-- migration records why, and the reason (a professional is also a customer) is
-- equally true in V3.
--
-- ## Ownership is a foreign key, not a convention
--
-- `conversations` carries a redundant-looking `UNIQUE (id, user_id)`, and
-- `messages` and `recommendations` carry composite foreign keys into it. That
-- makes "a message belongs to the same customer as its conversation" a
-- guarantee the DATABASE holds, not one the service remembers. It costs one
-- index and it removes an entire class of bug -- the one where a query joins on
-- `conversation_id` and forgets to also filter `user_id`, which is exactly how
-- one customer's thread ends up in another's list.
--
-- `ON DELETE CASCADE` throughout: `V32-DEC-003` requires deletion to destroy
-- the messages immediately rather than flag them, and a cascade is what makes
-- the destruction atomic with the parent's removal instead of a second
-- statement that can be forgotten or fail alone.

CREATE SCHEMA IF NOT EXISTS ai;

-- --------------------------------------------------------------------------
-- One bounded session. Many per customer, capped at 20 retained.
-- --------------------------------------------------------------------------
CREATE TABLE ai.conversations (
    id UUID PRIMARY KEY,
    -- The owner, always resolved from the authenticated session. No route
    -- anywhere accepts this value from a caller.
    user_id UUID NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    -- Why it closed, so a list can tell a customer whether their thread aged
    -- out or was superseded by the one they started next. NULL while active.
    closure_reason VARCHAR(20),
    -- Maintained by the service inside the same transaction as the message
    -- insert. Denormalized deliberately: the conversation list is the assistant's
    -- landing surface, and computing a count per row there is a correlated
    -- subquery on the largest table in the schema.
    message_count INTEGER NOT NULL DEFAULT 0,
    -- The inactivity horizon is measured from here. Updated on every ACCEPTED
    -- message, never on a read -- a customer scrolling their own history must
    -- not keep a session alive forever, because that would make the 24-hour
    -- bound depend on browsing rather than on use.
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_ai_conversations_status CHECK (status IN ('active', 'closed')),
    CONSTRAINT ck_ai_conversations_closure_reason CHECK (
        closure_reason IS NULL OR closure_reason IN ('inactivity', 'superseded')
    ),
    -- A closed conversation has a closure time and a reason; an active one has
    -- neither. Without this, "closed" and "closed_at IS NOT NULL" become two
    -- facts that can disagree, and the retention sweep reads one of them.
    CONSTRAINT ck_ai_conversations_closed_consistently CHECK (
        (status = 'closed' AND closed_at IS NOT NULL AND closure_reason IS NOT NULL)
        OR (status = 'active' AND closed_at IS NULL AND closure_reason IS NULL)
    ),
    CONSTRAINT ck_ai_conversations_message_count CHECK (message_count >= 0),

    -- The target of every child table's composite FK. See this file's header:
    -- it makes single-party ownership a database guarantee rather than a
    -- WHERE clause somebody has to remember.
    CONSTRAINT uq_ai_conversations_id_user UNIQUE (id, user_id)
);

-- The conversation list: one customer's conversations, newest activity first.
CREATE INDEX ix_ai_conversations_user_activity
    ON ai.conversations (user_id, last_activity_at DESC, id DESC);

-- The inactivity sweep reads exactly this: active conversations whose last
-- activity is older than the horizon. A partial index keeps it off the closed
-- rows, which are the majority after the first month.
CREATE INDEX ix_ai_conversations_active_stale
    ON ai.conversations (last_activity_at) WHERE status = 'active';

-- The retention sweep and the cap eviction both read closed conversations by
-- age within one customer. Eviction takes the OLDEST CLOSED one, and it must
-- never be able to see an active row.
CREATE INDEX ix_ai_conversations_closed_oldest
    ON ai.conversations (user_id, closed_at) WHERE status = 'closed';

-- --------------------------------------------------------------------------
-- Messages. Customer-authored free text lives here and nowhere else.
-- --------------------------------------------------------------------------
CREATE TABLE ai.messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    -- Denormalized owner. Not a convenience: it is half of the composite FK
    -- below, which is what makes cross-customer contamination unrepresentable.
    user_id UUID NOT NULL,
    role VARCHAR(16) NOT NULL,
    /*
     * The message text.
     *
     * This is the most sensitive prose in the platform -- an AI thread can
     * contain a customer's stated beauty and health concerns -- and it is
     * `subject_data` under `V32-DEC-007`: exported in full on request, destroyed
     * on erasure, destroyed on individual conversation deletion, and swept at 30
     * days.
     *
     * It is stored HERE and in no other table, no event payload, no analytics
     * dimension, no metric label, no log line, and no error report (ADR-030 T6).
     * There is no column anywhere else in this schema able to hold it.
     *
     * TEXT with a CHECK rather than VARCHAR(1000): the product limit is
     * expressed in Unicode code points and enforced in the application, where
     * NFC normalisation happens (see `aiInputLength`). PostgreSQL's
     * `length()` counts characters, not code points, so a VARCHAR cap would be
     * a SECOND, subtly different limit. The CHECK here is a backstop against a
     * grossly wrong write, not the product rule.
     */
    body TEXT NOT NULL,
    -- Position within the conversation. Deterministic ordering is a contract
    -- requirement: an export must be readable, and `created_at DESC` ties when
    -- a customer message and its reply are written in one transaction.
    sequence INTEGER NOT NULL,
    /*
     * Which provider produced this reply, and what kind of thing it was.
     *
     * NULL on customer messages. Recorded on assistant messages because
     * `V32-DEC-008` requires provider mode to be recorded honestly, and because
     * a stored conversation must still be able to say, months later, that a
     * particular paragraph came from a deterministic local assistant rather
     * than a language model (ADR-029 §4).
     *
     * The provider KEY, never a payload. No prompt, no raw response, no token
     * count from a vendor's envelope: ADR-029 rejects storing provider payloads
     * as domain truth.
     */
    provider_key VARCHAR(40),
    provider_state VARCHAR(20),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_ai_messages_role CHECK (role IN ('customer', 'assistant')),
    CONSTRAINT ck_ai_messages_body_not_blank CHECK (length(btrim(body)) > 0),
    CONSTRAINT ck_ai_messages_body_bounded CHECK (length(body) <= 4000),
    CONSTRAINT ck_ai_messages_sequence CHECK (sequence > 0),
    CONSTRAINT ck_ai_messages_provider_state CHECK (
        provider_state IS NULL OR provider_state IN ('simulated', 'external', 'unavailable')
    ),
    -- A customer message has no provider; an assistant message always has one.
    CONSTRAINT ck_ai_messages_provider_matches_role CHECK (
        (role = 'customer' AND provider_key IS NULL AND provider_state IS NULL)
        OR (role = 'assistant' AND provider_key IS NOT NULL AND provider_state IS NOT NULL)
    ),

    -- Composite, so a message cannot belong to one customer while its
    -- conversation belongs to another. CASCADE, so deleting a conversation
    -- destroys its messages in the same statement (`V32-DEC-003`).
    CONSTRAINT fk_ai_messages_conversation FOREIGN KEY (conversation_id, user_id)
        REFERENCES ai.conversations (id, user_id) ON DELETE CASCADE,

    -- Deterministic ordering, and idempotent appends: two concurrent writers
    -- cannot both claim sequence N.
    CONSTRAINT uq_ai_messages_sequence UNIQUE (conversation_id, sequence),

    -- The target of `ai.recommendations`' composite FK, for the same reason
    -- `ai.conversations` carries one: a recommendation cannot belong to one
    -- customer while the reply that produced it belongs to another.
    CONSTRAINT uq_ai_messages_id_user UNIQUE (id, user_id)
);

CREATE INDEX ix_ai_messages_conversation ON ai.messages (conversation_id, sequence);
-- The subject-data export reads every message a user ever sent, in order,
-- across conversations.
CREATE INDEX ix_ai_messages_user ON ai.messages (user_id, created_at);

-- --------------------------------------------------------------------------
-- Recommendations. What survived independent re-verification.
-- --------------------------------------------------------------------------
--
-- A row here is NOT what the provider said. It is what the provider said AND
-- what the catalogue confirmed still exists, is still public, and is still
-- visible (ADR-030 T3). A hallucinated, hidden, suspended, deleted, or foreign
-- id never reaches this table, which is why there is no `verified` flag: an
-- unverified recommendation has no representation.
--
-- There is deliberately no slot, booking, or order target type. `V32-DEC-004`
-- prohibits a preselected booking slot, and the way that is kept is by having
-- no column able to express one.
CREATE TABLE ai.recommendations (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL,
    conversation_id UUID NOT NULL,
    user_id UUID NOT NULL,
    target_type VARCHAR(20) NOT NULL,
    target_id UUID NOT NULL,
    /*
     * The public display name, snapshotted at the moment the recommendation was
     * shown.
     *
     * Snapshotted for the reason commerce snapshots a line item's price: the
     * export and the stored conversation must still make sense after the
     * professional renames themselves, and re-resolving at read time would make
     * a historical conversation say something it never said. It is a PUBLIC
     * catalogue field, so this is not a privacy widening.
     */
    display_name VARCHAR(191) NOT NULL,
    position INTEGER NOT NULL,
    -- Usefulness is measured as shown-then-clicked, which is V2's model and the
    -- right one: it measures whether the assistant helped without retaining
    -- anything anybody typed.
    clicked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_ai_recommendations_target_type CHECK (target_type IN ('professional', 'service')),
    CONSTRAINT ck_ai_recommendations_position CHECK (position >= 1 AND position <= 4),

    CONSTRAINT fk_ai_recommendations_message FOREIGN KEY (message_id, user_id)
        REFERENCES ai.messages (id, user_id) ON DELETE CASCADE,
    CONSTRAINT fk_ai_recommendations_conversation FOREIGN KEY (conversation_id, user_id)
        REFERENCES ai.conversations (id, user_id) ON DELETE CASCADE,

    CONSTRAINT uq_ai_recommendations_message_position UNIQUE (message_id, position)
);

CREATE INDEX ix_ai_recommendations_message ON ai.recommendations (message_id, position);
CREATE INDEX ix_ai_recommendations_user ON ai.recommendations (user_id, created_at);

-- --------------------------------------------------------------------------
-- The one-time acceptance (`V32-DEC-006`).
-- --------------------------------------------------------------------------
--
-- One row per customer, keyed on the customer, because the acceptance IS
-- one-time. There is no version column and no withdrawal column, and their
-- absence is the decision: a versioned, withdrawable consent trail is the
-- platform-wide system scheduled at V3.3-E, and building it here for one
-- consumer would be building it for one consumer.
--
-- `contract_key` names WHICH acceptance was recorded, so an acceptance gathered
-- under the sandbox disclosure is distinguishable from one gathered under the
-- legally-reviewed copy that does not exist yet. Without it, the eventual
-- approved wording would arrive with no way to tell who had ever seen it.
CREATE TABLE ai.assistant_consents (
    user_id UUID PRIMARY KEY,
    contract_key VARCHAR(60) NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ck_ai_consents_contract_key_not_blank CHECK (length(btrim(contract_key)) > 0)
);

-- --------------------------------------------------------------------------
-- The daily quota (`V32-DEC-008`). The correctness limit, in PostgreSQL.
-- --------------------------------------------------------------------------
--
-- Twenty accepted customer messages per user per TEHRAN calendar day,
-- incremented in the SAME TRANSACTION as the message insert.
--
-- Why a table rather than the HTTP throttler: the throttler's storage is
-- in-memory per process, which is correct at single-instance scale and silently
-- wrong the moment a second instance exists -- the effective limit multiplies by
-- instance count. That topology question is `THROTTLE-STORE` and is unresolved.
-- A PostgreSQL row is shared across every instance by construction, so the
-- correctness limit does not depend on an answer nobody has yet.
--
-- Why in the same transaction: `GAP-04` records V2's campaign caps losing to a
-- read-then-write race. The increment here is a single conditional
-- `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < limit RETURNING`, so two
-- concurrent requests cannot both observe 19 and both write 20.
--
-- Why the deterministic provider is counted too: zero external cost is not a
-- reason to exempt a path. The retention and export obligations are identical
-- whichever provider answered, and a quota that only exists on the expensive
-- path is a quota nobody has tested.
CREATE TABLE ai.usage_daily (
    user_id UUID NOT NULL,
    -- The Tehran calendar day, computed by the application from an injected
    -- clock and passed in as a parameter -- NOT `now() AT TIME ZONE 'Asia/Tehran'`
    -- computed here. A day boundary the tests cannot move is a day boundary
    -- nobody has proved, and proving the reset is a mandatory test.
    usage_day DATE NOT NULL,
    -- The quota counter. Counts ACCEPTED customer messages only: a refused,
    -- invalid, unauthorized, or injection-blocked request must not spend a
    -- user's allowance (ADR-030 T5).
    accepted_messages INTEGER NOT NULL DEFAULT 0,
    -- Honest provider accounting, split so an operator can see what actually
    -- served without reading anybody's conversation (`V32-DEC-009`).
    simulated_replies INTEGER NOT NULL DEFAULT 0,
    external_replies INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (user_id, usage_day),
    CONSTRAINT ck_ai_usage_counts_non_negative CHECK (
        accepted_messages >= 0 AND simulated_replies >= 0 AND external_replies >= 0
    )
);

-- The operator's aggregate view: usage per day across all customers. No content
-- route exists (`V32-DEC-009`), so this index serves counts and nothing else.
CREATE INDEX ix_ai_usage_day ON ai.usage_daily (usage_day);

-- --------------------------------------------------------------------------
-- The transactional outbox.
-- --------------------------------------------------------------------------
--
-- Identical in shape to every other schema's. What differs is what may travel
-- in `payload`: ids, counts, enums, and timestamps only. The AI event contracts
-- have no field able to hold a message body, a prompt fragment, or a completion
-- (ADR-030 T6), which is the same discipline `notification` applies to message
-- bodies and `journey` to goal titles.
CREATE TABLE ai.outbox_events (
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

CREATE INDEX ix_ai_outbox_unpublished ON ai.outbox_events (id) WHERE published_at IS NULL;
CREATE INDEX ix_ai_outbox_correlation ON ai.outbox_events (correlation_id);
