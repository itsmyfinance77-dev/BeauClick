-- Correlation id on the outbox: the identifier that ties one customer action
-- to everything it caused, across every schema it fanned out to.
--
-- V3_EVENT_CATALOG.md required this from the start and the column did not
-- exist. It becomes load-bearing in Phase 3, where a single completed booking
-- reaches five independent consumers in five schemas -- without it, "why did
-- this customer get this notification" is answered by comparing timestamps
-- and hoping nothing else happened in the same second.
--
-- NULLABLE on purpose. Rows written before this migration have no honest
-- value, and inventing one would make the column lie about traces that were
-- never recorded. Every row written after it has one.
ALTER TABLE notification.outbox_events
    ADD COLUMN IF NOT EXISTS correlation_id UUID;

-- Answers "show me everything this action caused" without scanning the table.
-- Partial: a NULL correlation id is a pre-migration row and is never a search
-- target, so it does not belong in the index.
CREATE INDEX IF NOT EXISTS ix_notification_outbox_correlation
    ON notification.outbox_events (correlation_id)
    WHERE correlation_id IS NOT NULL;
