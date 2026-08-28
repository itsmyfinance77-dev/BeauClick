-- ---------------------------------------------------------------------------
-- When a DEVICE signed in, as distinct from when its current token was minted.
-- V3.1 Phase E, part of QA-20.
--
-- THE PROBLEM THIS EXISTS FOR. Refresh tokens rotate (ADR-014): every refresh
-- revokes the presented row and inserts a new one, chained through
-- `replaced_by_token_id`. That is correct, and it makes `created_at` useless as
-- an answer to the question a device-management screen actually asks. A phone
-- signed in three weeks ago and used daily has a row created eleven minutes
-- ago, so the screen would report "signed in 11 minutes ago" for every device
-- the user owns -- confidently, and wrongly, and in a way that makes it
-- impossible to recognise the laptop you left at the office.
--
-- `session_started_at` is carried forward across every rotation in the chain,
-- so it answers the question that was actually asked.
--
-- NULLABLE, and it stays nullable. Rows written before this migration have no
-- honest value to backfill: their chain's true start is knowable in principle
-- by walking `replaced_by_token_id` backwards, but those chains predate the
-- column and inventing a timestamp would be worse than reporting the one thing
-- that IS true -- `created_at`, which the API falls back to. Same treatment
-- `outbox_events.correlation_id` documents for the same reason.
-- ---------------------------------------------------------------------------

ALTER TABLE identity.refresh_tokens
    ADD COLUMN session_started_at TIMESTAMPTZ;

-- Existing LIVE rows get their own creation time. For a session that has never
-- rotated this is exactly right, and for one that has it is the best available
-- lower bound rather than a fabrication -- the row genuinely existed then.
-- Revoked rows are left NULL: nothing reads them for a start date, and writing
-- a value into dead rows would only make the column look more populated than
-- it is.
UPDATE identity.refresh_tokens
   SET session_started_at = created_at
 WHERE revoked_at IS NULL;
