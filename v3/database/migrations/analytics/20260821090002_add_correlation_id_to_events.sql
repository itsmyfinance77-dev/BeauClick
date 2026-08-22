-- The correlation id follows the fact into analytics.
--
-- Analytics is the one place that already sees every domain's events, so it is
-- where a cross-domain trace is actually answerable as a query rather than as
-- nine separate ones. Carrying the id here is what makes "this customer action
-- produced these facts" a single SELECT.
--
-- Deliberately NOT part of any metric: it is an identifier, never a dimension.
-- Grouping by it would produce one bucket per action, which is a trace, not a
-- metric, and the distinction is the whole reason `dimensions` is bounded.
ALTER TABLE analytics.events
    ADD COLUMN IF NOT EXISTS correlation_id UUID;

CREATE INDEX IF NOT EXISTS ix_analytics_events_correlation
    ON analytics.events (correlation_id)
    WHERE correlation_id IS NOT NULL;
