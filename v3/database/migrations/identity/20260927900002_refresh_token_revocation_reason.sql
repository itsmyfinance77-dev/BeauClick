-- ---------------------------------------------------------------------------
-- WHY a refresh token was revoked -- demo remediation F-9.
--
-- THE PROBLEM. Every revocation wrote the same column with no cause: a token
-- ROTATED by its holder and a token deliberately ENDED (logout, "sign out that
-- device", logout-all) looked identical. Replay detection treats any revoked
-- token presented after the 10 s grace as theft and revokes every session of
-- the user -- so a device that had been signed out from another device, and
-- simply came back, signed the remaining device out too (measured on the demo).
--
-- THE FIX. The reason is written in the SAME statement that sets `revoked_at`
-- on every path, and is never overwritten (every writer requires
-- `revoked_at IS NULL`). Only a token positively marked as intentionally ended
-- stops cascading; `rotated` and NULL keep today's replay response exactly.
--
-- NULLABLE, not backfilled: rows revoked before this migration have no honest
-- reason to record, and NULL keeps them on the strict (replay) path. Inferring
-- "intentional" from `replaced_by_token_id IS NULL` would be unsafe -- a crash
-- between the rotation claim and the successor pointer leaves a ROTATED token
-- with no successor.
-- ---------------------------------------------------------------------------

ALTER TABLE identity.refresh_tokens
    ADD COLUMN revocation_reason TEXT;

ALTER TABLE identity.refresh_tokens
    ADD CONSTRAINT ck_refresh_tokens_revocation_reason
    CHECK (revocation_reason IS NULL
           OR revocation_reason IN ('rotated', 'logout', 'session_revoked', 'logout_all', 'replay_response'));

-- A reason never exists without a revocation.
ALTER TABLE identity.refresh_tokens
    ADD CONSTRAINT ck_refresh_tokens_reason_requires_revocation
    CHECK (revocation_reason IS NULL OR revoked_at IS NOT NULL);
