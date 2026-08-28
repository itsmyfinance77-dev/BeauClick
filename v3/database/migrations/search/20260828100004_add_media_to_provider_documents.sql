-- ---------------------------------------------------------------------------
-- Imagery on the search projection (V3.1 Phase C).
--
-- `V3.1_PRODUCT_ROADMAP.md` §15's Phase C states the requirement plainly: "a
-- provider with work shown is a different search result than one without".
-- Making that true means the search document has to carry the imagery, which
-- means the PostgreSQL projection it is built from has to carry it too.
--
-- ALL FIVE COLUMNS ARE WRITTEN BY A DIFFERENT EVENT than the rest of the
-- document. `ProfessionalUpdated` carries the profile; `ProfessionalMediaChanged`
-- carries the imagery. The upsert in `applyProfessional` lists its columns
-- explicitly and does not name these, so a profile edit leaves the imagery
-- alone and vice versa -- the same treatment `services` already gets, and for
-- the same reason: an event that does not describe something must not blank it.
--
-- Both events carry the SAME per-professional `revision`, so the ordering
-- guarantee is unchanged: whichever arrives with the higher revision wins its
-- own columns, and neither can overwrite the other with stale data.
--
-- Defaults are chosen so every EXISTING row is immediately valid without a
-- backfill: a professional who has uploaded nothing has no avatar, no
-- portfolio, and an empty preview list, which is exactly what these defaults
-- say.
-- ---------------------------------------------------------------------------

ALTER TABLE search.provider_documents
    -- The avatar's public URL, resolved by the media module at emit time.
    --
    -- A URL rather than a media id, deliberately. The consumer is an OpenSearch
    -- document that a browser renders directly; storing an id would mean either
    -- search-service resolving ids to URLs -- which requires it to know about
    -- media, a module it must not depend on -- or every client doing a second
    -- round trip per result. The cost is that a URL scheme change requires a
    -- reindex, which is a rare, planned operation the reindex machinery already
    -- exists for.
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,

    -- Intrinsic dimensions, carried so a result card can reserve space before
    -- the image loads. This is the whole mechanism behind Phase C's
    -- "zero layout shift" requirement; without it a search results page
    -- reflows as every avatar arrives.
    ADD COLUMN IF NOT EXISTS avatar_width INTEGER,
    ADD COLUMN IF NOT EXISTS avatar_height INTEGER,

    -- How many live portfolio items the professional has. A count rather than
    -- a derived boolean, because "has work" and "has a lot of work" are
    -- different signals and a boolean throws the second away.
    ADD COLUMN IF NOT EXISTS portfolio_count INTEGER NOT NULL DEFAULT 0,

    -- A bounded preview set for the result card. Bounded at the producer, not
    -- here: an unbounded array would let one professional's gallery dominate
    -- the size of every search response they appear in.
    ADD COLUMN IF NOT EXISTS portfolio_preview_urls TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE search.provider_documents
    ADD CONSTRAINT ck_provider_documents_portfolio_count CHECK (portfolio_count >= 0);
