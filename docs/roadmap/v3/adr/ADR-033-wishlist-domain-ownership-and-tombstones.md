# ADR-033: The Wishlist Domain — Ownership, Saveable Targets, and Neutral Tombstones

**Status:** Accepted — implemented in V3.2-C Story #8 (contract, persistence, API, privacy lifecycle). **The two halves this ADR deferred to Story #9 — the rendered target state (§6, §140) and saved-state hydration (§4) — landed on 2026-08-31 as [ADR-034](./ADR-034-wishlist-saved-state-hydration-and-target-state-projection.md).** ADR-034 revisits nothing here: ownership, the target set, the tombstone rule, the cap, and the erasure model are unchanged. It does absorb `WishlistSaveableTargetPort` into a broader batch port, which is exactly what §4 said should happen.
**Date:** 2026-08-30.
**Relates to:** ADR-011 (repository architecture and module boundaries), ADR-027 (subject-data contract, boot-time coverage), ADR-021 (search read model — one ranking implementation), ADR-029/ADR-030 (the AI catalogue port whose re-verification discipline this ADR copies), `V3_SECURITY_MODEL.md` §3 (indistinguishable refusals, no caller-supplied identity), `V3_DOMAIN_BOUNDARIES.md` (whose `provider.wishlist_items` proposal this ADR overrules on the merits).
**Binding on:** `V32-DEC-020` and `V32-DEC-021`, closed by the product owner on 2026-08-30.

## Context

A wishlist is the smallest genuinely complete capability in the V3.2 programme: a customer saves a professional or a service, sees the list later, and removes an entry. Almost every decision in it is about what *not* to build.

Three facts about the repository shaped this ADR more than any product argument.

**A saved row is about a customer, not about a provider.** `V3_DOMAIN_BOUNDARIES.md` pre-assigns `wishlist_items` to the `provider` schema, and the assignment is defensible on the surface — the targets are provider entities. It is wrong on the merits, because the row's *disposition* is `subject_data` keyed on `user_id`, and placing it in `provider` would hand that module an erasure obligation for a subject it otherwise knows nothing about.

**"Hidden" and "unpublished" do not exist.** The V3.2-C decision packet found that `provider.services` carries no publish, visibility, or active flag of any kind, and `provider.professionals` carries only `deleted_at` and a `verification_status` state machine. A decision written in terms of hidden or unpublished targets could not have been implemented without inventing a state.

**Search does not hide unverified professionals.** `SearchService.searchProviders` filters only `is_deleted = false`; `verifiedOnly` is an optional caller filter. A customer can legitimately find, save, and book an unverified professional, so a wishlist that called them unavailable would contradict the page the customer saved from.

## Decision

### 1. A `wishlist` module owning a `wishlist` schema — not `provider`, not `journey`

`V32-DEC-020` settles ownership as a new module and schema.

`provider` is refused for the reason above: erasure obligation for a foreign subject.

`journey` is refused for the opposite reason — it would *work*. `journey` already owns customer preference data and already deletes rather than anonymises on erasure, so the treatment would be identical. It is refused because `JourneyContextProvider` is a load-bearing AI privacy boundary: `inferAiDefaults` has no string field at all, and that structural guarantee is easier to keep true in a module that owns one concern. Growing a second, unrelated concern inside it buys nothing and costs the clarity of that boundary.

The module depends on **nothing** at runtime except its own schema and the shared libraries. Its one seam is a port, bound by the composition root (§4).

### 2. Two target types, and the two that are refused are refused for different reasons

Saveable: **`professional`** and **`service`**. Both are stable application-generated UUID primary keys that survive every edit to the entity, both are already public, and both already have a public summary shape.

**Portfolio items are refused on evidence.** `uq_portfolio_media_live` is partial on `deleted_at IS NULL`, so a professional who removes an image and re-adds the same media produces a *new item id*. Saved portfolio items would become unavailable during routine gallery maintenance — the sharpest tombstone behaviour in the programme for the least product value.

**Businesses are refused because they are not implementable.** `services/business` exposes **no `@Public()` route anywhere** — `GET /businesses/:id` is guarded by `BusinessMembershipResolver` — and businesses have no document type in the search index, which is keyed on `professional_id`. Saving a business would require building a public business profile first. That capability is recorded as unscheduled in `V3.2_PLUS_CAPABILITY_CATALOG.md`; it is not a wishlist target waiting for approval.

### 3. Duplicate saving is unrepresentable, and that constraint *is* the idempotency guarantee

`UNIQUE (user_id, target_type, target_id)`.

This is deliberately the same shape as `loyalty.points_entries`' `uq_points_entries_reference_once`, and for the same reason its migration records: a check-then-insert lets two concurrent handlers both observe "not yet saved" and both insert. The index is the only mechanism, so there is no weaker path to accidentally rely on. `INSERT … ON CONFLICT DO NOTHING` then makes add idempotent by construction rather than by an application branch.

Remove is idempotent for the mirror-image reason: it is a `DELETE` by `(user_id, target_type, target_id)` that always answers the same way, whether it removed a row or not.

### 4. Add-time validation, and the boundary with Story #9

**A target must currently resolve as saveable before it can be added.** Without this, `POST /items` accepts any well-formed UUID and a customer's list fills with rows that can never render as anything but unavailable.

This requires reading the authoritative `provider` tables, which `wishlist` may not import (ADR-011, lint-enforced). So `wishlist` declares `WISHLIST_SAVEABLE_TARGET` and the composition root binds it — the pattern `apps/api/src/composition/ai-ports.ts` already establishes.

**The port reads the authoritative tables, never the search projection.** `PublicCatalogueAiAdapter`'s docblock states why and the reasoning transfers unchanged: the search projection is eventually consistent, so a professional suspended thirty seconds ago is still in the index, and validating against it would confirm exactly the record the platform has just decided must not be shown.

**Scope boundary, stated so Story #9 does not duplicate it.** This port answers **one** question about **one** target at add time: *may this be saved right now?* Story #9 owns the **batch projection** that computes and returns the `available | unavailable` state of already-saved items for a page of results. The two share the predicate in §5 and must keep sharing it; if #9 introduces a broader port, this one is absorbed rather than duplicated.

### 5. One predicate, used in both directions

A target is **unavailable** — and therefore **not saveable** — when:

- it is soft-deleted (`deleted_at IS NOT NULL`), **or**
- its owning professional is soft-deleted, **or**
- its owning professional's `verification_status` is `suspended` or `revoked`.

A professional whose status is `unverified`, `pending`, or `rejected` is **available and saveable**, per the third context fact above.

This deliberately differs from the AI assistant's stricter `verified`-only rule in `reverifyProfessionals`. The difference is not an inconsistency: a recommendation is the platform vouching for someone, and a wishlist is the customer's own choice about someone they already found.

The second-order case is load-bearing and easy to miss: **a service row survives its professional's suspension**, so checking only `services.deleted_at` would let a customer save a treatment offered by somebody the platform has just stopped showing. `reverifyServices` already makes this mistake impossible for AI; the wishlist port makes the same join.

### 6. The saved row is a neutral tombstone, by construction

`V32-DEC-021` chose the surviving entry over silent removal and over notify-then-remove.

**At the persistence layer — this ADR's half — the property is that nothing ever removes or hides a saved row because its target changed.** There is no cascade from `provider`, no sweep, no `deleted_at`, no retention horizon, and no filter on target state anywhere in the list query. A saved row is destroyed by exactly two things: the customer removing it, and the customer erasing their account.

That has a consequence worth stating: a target that is suspended and later restored becomes available again with **no write**, because availability is computed per read and is never cached on the row.

**The neutrality is also structural.** This module holds no target state, so it cannot leak one. The list response carries the ids the customer supplied plus the instant they saved them, and nothing else. The `unavailable` state itself — a single value with **no cause** — arrives with Story #9, and the reason it must stay causeless is a security property rather than a presentation preference: distinguishing deleted from suspended from revoked would turn every customer's wishlist into a live feed of moderation and verification decisions about named third parties.

### 7. No display snapshot

No `display_name`, price, image, city, or rating is copied onto the saved row.

`provider` and `search` stay authoritative for public target data. A snapshot would be a stale second copy of public data *plus* a subject-data claim over a third party's prose — bought in order to render exactly the name §6 forbids showing for an unavailable target.

### 8. The cap is enforced under a per-user lock, not by a preceding count

At most **500** saved items per customer.

A count-then-insert is the `GAP-04` defect: two concurrent adds both observe 499 and both insert. A single `INSERT … SELECT … WHERE (SELECT count(*) …) < 500` does not fix it either — under `READ COMMITTED` both statements evaluate the subquery against a snapshot taken before either insert.

Two mechanisms can make it correct, and the choice is recorded because it is the one place this module departs from the nearest precedent:

- **A per-user counter row**, conditionally incremented — the `ai.usage_daily` and `chat.send_counters` shape. Correct, and it introduces a denormalised count that must be decremented on every remove and on erasure, and that can drift from the rows it claims to count. `loyalty` refuses a cached balance for exactly this reason.
- **A transaction-scoped advisory lock keyed on the subject**, taken before the count. Correct, introduces no second source of truth, no decrement path, and no extra table.

**The advisory lock is chosen.** Adds serialise per customer, which is precisely the set the cap is about — the same argument `chat.send_counters` makes for bucketing by minute. Two different customers whose keys collide in `hashtext` serialise momentarily and harmlessly.

The counter shape remains the right answer where a *rate* is being limited over time, because there the counter is the state; here the rows are the state and a counter would only shadow them.

### 9. Subject data: `subject_data`, exported for its owner, hard deleted on erasure

`journey`'s treatment, and its reasoning applies without modification: a saved id is one person's stated preference, single-party, and referenced by nobody. The platform's anonymise-with-referential-integrity default exists for rows that are half of a two-party fact; nothing here is.

Erasure **deletes**. There is no tombstone row, no anonymised owner, and no retained shell — keeping them would be keeping personal data for no reason, and the anonymisation default applied here out of consistency would be the wrong answer arrived at by rule-following.

Every identity column ends in `_user_id` or is named `user_id`, so ADR-027's coverage heuristic would reject a `no_subject_data` claim on this table if anyone ever made one. The naming is belt; the declared disposition and its test are braces.

### 10. No events, no outbox, no notification, no analytics, no ranking

There is **no `wishlist.outbox_events` table**, and `wishlist` is **not** added to `ServiceName`.

No consumer exists. `analytics.events` could not accept the fact anyway without widening `ck_analytics_events_subject_normalized`, which admits seven subject types and none that fits. A notification to a professional that somebody saved them would publish a private list; a notification to a customer that a target became unavailable would disclose a third party's status change.

A popularity count or ranking signal is refused separately and more strongly: it would require a new column on `search.ranking_signals`, a `PROVIDER_INDEX_MAPPING_VERSION` bump, and a full reindex — and `V32-DEC-021` forbids it outright.

Adding an event later is additive. Shipping one nothing reads is not.

### 11. Authorization: authenticated, session-scoped, no new capability

No `bc_*` capability is created. `journey`'s `/v1/me/journey` and the customer half of `/v1/me/loyalty` are authenticated-only for the same reason: the surface acts exclusively on the caller's own data and gates no privileged action. `ai` requires a capability because its surface has real cost and safety consequences; a saved id has neither.

**No route accepts a caller-supplied user, customer, or owner identity**, in a body, a query parameter, or a path segment. The subject is always `@CurrentUser().userId`.

`POST /items` carries a target type and id, and that is not an exception: the target is a public catalogue entity whose existence the public profile route already discloses, so the value narrows a public set rather than naming a party.

Every refusal — a target that does not exist, one that is soft-deleted, one whose professional is suspended or revoked — is the platform's single `NotFoundOrNotYoursException`, with one code and one Persian message.

## Consequences

- The wishlist can be built, tested, and shipped with **no external dependency of any kind**, and with no dependency on any other V3.2-C story.
- Story #9 inherits a fixed contract and one shared predicate. It adds the batch projection and the saved-state hydration; it does not revisit ownership, the target set, or the tombstone rule.
- A saved row may point at a target that later becomes unavailable and stays that way forever. That is the decided behaviour, and the customer's remove control is the only thing that clears it.
- Because the cap is a lock rather than a counter, `SELECT count(*)` per add is a real query. It is bounded by 500 rows on an index over `user_id`, which is the cheapest count in the schema.

## What is deliberately not decided here

- **The rendered `unavailable` state and its vocabulary** — Story #9.
- **Saved-state hydration for search and profile surfaces** — Story #9.
- **Any frontend** — Story #10.
- **Named collections, folders, sharing, public wishlists, popularity counts** — refused by `V32-DEC-021`, and additive if ever approved.
- **Businesses and portfolio items as targets** — refused by `V32-DEC-020`. Businesses additionally require a public-business-profile capability that is scoped nowhere.
