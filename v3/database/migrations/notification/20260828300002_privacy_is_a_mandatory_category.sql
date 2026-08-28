-- ---------------------------------------------------------------------------
-- `privacy` joins `booking` and `payment` as a category a user cannot switch
-- off. V3.1 Phase E.
--
-- The three privacy notifications are "we received your request", "your export
-- is ready", and -- the one this constraint exists for -- "your account will
-- be deleted, and here is until when". That last message is the only thing
-- standing between an accidental deletion and an irreversible one, and the
-- grace window (GAP-21) is worthless if the user never hears that it is open.
--
-- Someone who has muted marketing has not consented to missing that.
--
-- The original migration is NOT edited: it stays exactly as it shipped, and
-- this file changes the constraint forward. Same discipline every other
-- additive change in this project follows.
-- ---------------------------------------------------------------------------

ALTER TABLE notification.preferences
    DROP CONSTRAINT ck_preferences_mandatory_always_enabled;

-- BEFORE the new constraint, not after: an existing opt-out row for the new
-- category would make the ADD fail outright, and a migration that aborts on
-- data it could have corrected is a migration that will abort in production
-- and not in test. There can be no such row today -- the category did not
-- exist until this file -- which is precisely why handling it here costs
-- nothing and handling it later would cost a rollback.
UPDATE notification.preferences SET enabled = true WHERE category = 'privacy' AND NOT enabled;

ALTER TABLE notification.preferences
    ADD CONSTRAINT ck_preferences_mandatory_always_enabled CHECK (
        enabled OR category NOT IN ('booking', 'payment', 'privacy')
    );
