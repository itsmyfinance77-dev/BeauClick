# ADR-034: Wishlist Saved-State Hydration and the Neutral Target-State Projection

**Status:** Accepted — implemented in V3.2-C Story #9 (discovery integration, target-state projection).
**Date:** 2026-08-31.
**Relates to:** ADR-033 (the wishlist domain — this ADR is the half §4 and §6 explicitly deferred), ADR-011 (repository architecture and module boundaries), ADR-021 (search read model — one ranking implementation), ADR-029/ADR-030 (the AI catalogue port whose re-verification discipline both directions copy), `V3_SECURITY_MODEL.md` §3 (indistinguishable refusals, no caller-supplied identity).
**Binding on:** `V32-DEC-020` and `V32-DEC-021`, closed by the product owner on 2026-08-30. **This ADR revisits no decision.** Ownership, the target set, the tombstone rule, the cap, and the erasure model are ADR-033's and are unchanged.

## Context

ADR-033 built the wishlist and deliberately stopped at two places.

It stopped at the **rendered target state**: a saved item was returned with the ids the customer supplied and the instant they saved them, and nothing else. Declaring an `available | unavailable` vocabulary that nothing could produce would have been a promise a client codes against before anything can keep it, and an always-`available` field would have been worse than an absent one — wrong rather than missing.

It stopped at **saved-state hydration**: nothing in `search` or `provider` knew a wishlist existed, so a customer could save a professional and then find no trace of it on the page they saved from.

Story #9 is those two halves, and each turns out to be a different problem in a different direction.

Three facts about the repository shaped this ADR.

**The saved list is per-customer; the search index is shared.** There is exactly one search document per professional and it is served to everyone. There is no field on it that can mean "you saved this", because there is no *you*.

**The search projection is eventually consistent and the provider tables are not.** ADR-030 T3 already established which one a gate reads, and `PublicCatalogueAiAdapter` records the reasoning at length. A target-state projection is a gate.

**ADR-011 forbids `search` and `provider` from importing `wishlist`, and forbids `wishlist` from importing `provider`.** Every arrow in this story crosses a boundary that lint enforces.

## Decision

### 1. The Story #8 port is absorbed, not extended

`WishlistSaveableTargetPort.isSaveable(manager, target)` becomes `WishlistTargetPort.availableTargets(manager, targets)`.

ADR-033 §4 wrote down what should happen if this story needed a broader port: *"if #9 introduces a broader port, this one is absorbed rather than reimplemented."* This is that absorption. `save` now calls the batch method with a single-element array.

The alternative — keeping `isSaveable` and adding a batch method beside it — was rejected because the predicate in ADR-033 §5 **is** `V32-DEC-021`, and a decision with two implementations is a decision with two answers. The two would be free to drift, and the drift would show up as a target a customer could save but that immediately rendered unavailable, or the reverse.

### 2. The batch is answered in at most two queries, and the bound does not depend on the page

1. The named services, live ones only, for their owning professional ids.
2. Every professional the answer depends on — those named directly **plus** the owners discovered in (1) — in one `IN`.

Query (1) is skipped when the batch names no services. A page of fifty saved items costs two queries; a page of one costs one.

This is a decision rather than an optimisation, because the obvious implementation is a loop and the loop is correct. It is measured rather than asserted: the suite records every statement the request issues and pins the counts at exactly 1 and exactly 2, and the assertion was verified non-vacuous by temporarily rewriting the method as a loop, which produced 60.

### 3. Availability is computed per read, and there is nowhere to store it

No column, no cache, no memo. ADR-033 §6 already stated the consequence — a suspended-then-restored target becomes available again with **no write** — and this ADR makes it observable: the test asserts both that the request issued no wishlist mutation and that the row's `ctid` and `xmin` are unchanged.

The state is computed **after** the page's rows are chosen, never as a filter or an ordering term. That is what keeps pagination stable while targets change underneath a paging client: because nothing about target state reaches the `WHERE` clause or the `ORDER BY`, a professional suspended between page 1 and page 2 cannot make a row skip, repeat, or move.

### 4. The rendered state has exactly two members, and the second has no cause

`available | unavailable`. Soft-deleted, owner soft-deleted, owner suspended, owner revoked, and never-existed are five internal situations and one rendered value.

The collapse is a **security property**, not a presentation preference. Distinguishing them would turn every customer's saved list into a live feed of moderation and verification decisions about named third parties — one the customer never asked for and the professional never consented to. It is the same collapse `WISHLIST_REFUSAL_REASONS` already applies to the add path, so the two halves of the contract cannot disagree.

The absence is structural rather than remembered: the port returns a **set of keys**, not a map of reasons, so there is no value in the system that could carry a cause even by accident. Proved by whole-response comparison — three causes produce byte-identical items once ids and instants are normalised — and by a key-set comparison against an independently written literal.

A professional who is merely `unverified`, `pending`, or `rejected` is **available**. `SearchService.searchProviders` filters only `is_deleted`, so ordinary discovery still returns them, and this story changes no search visibility policy.

### 5. Saved state is hydrated after the search, never indexed into it

The obvious implementation is a field on the search document, and it is wrong. A saved item belongs to one customer; the document is shared by every customer who searches. Storing it there would mean either a document per `(professional, customer)` pair — unbounded — or a per-customer filter on a shared document, which is a privacy hazard one query-builder mistake away from showing one customer another's list.

So the saved state is read **from the authoritative table, for the caller alone, after the engine has chosen and ranked the results**. Two consequences follow and both are wanted:

- The results are strictly consistent for the saved marker and eventually consistent for everything else. A customer who just tapped save sees it on the next page load even though the index has not moved.
- **A save can never become a ranking signal.** The hydration happens after ranking, joins nothing the engine chose results with, and the suite asserts that a signed-in caller and an anonymous one receive the same ids in the same order. `V32-DEC-021` refuses a popularity signal outright; `search.ranking_signals`, `ranking.ts`, and `PROVIDER_INDEX_MAPPING_VERSION` are untouched.

### 6. Two ports in opposite directions, one adapter each, both bound in the composition root

| Port | Declared by | Reads | Answers |
|---|---|---|---|
| `WISHLIST_TARGET_PORT` | `wishlist` | `provider` | is this target showable? |
| `WISHLIST_SAVED_TARGETS` | `search` **and** `provider` | `wishlist` | has this customer saved these? |

Neither domain imports the other. Both bindings live in `apps/api`, which is `scope:app` and the only place permitted to depend on every domain.

`search` and `provider` each declare their **own** symbol, because ADR-011 forbids either importing the other's — and both are bound with `useExisting` to the **same instance**. That is exactly what `PROFESSIONAL_DIRECTORY` and `PROFESSIONAL_OWNER_LOOKUP` already do, and for the reason `DomainPortsModule` records: a second implementation answering the same question a second way is how two surfaces start disagreeing about whether something is saved.

The bindings are **two `@Global()` modules, not one**. `WishlistPortsModule` imports `ProviderModule`; putting the reverse binding there would additionally require importing `WishlistModule`, whose service resolves a token from that same module. Two modules keep both graphs acyclic.

**Neither consumer provides a default.** A composition that omits the binding fails to boot. The alternative — an `@Optional()` injection falling back to `null` — would ship a marketplace where every signed-in customer's save control renders as "unknown" forever, with no error anywhere. That is the failure mode `SearchModule`'s in-memory-engine guard exists to prevent for search itself, and the argument transfers.

### 7. `saved` is `boolean | null`, and the third value is load-bearing

`true`/`false` for an authenticated caller; `null` when there is none, or when the response is not a discovery read.

`null` rather than `false` for an anonymous visitor, because `false` is a claim — "you have not saved this" — made about somebody the server cannot identify. It is also the treatment `images` and `rating` already get on the same public professional shape, and for the reason that shape records: a consumer forced to distinguish "this response predates the field" from "the field is false" writes the same `?? null` at every call site until one of them forgets.

An anonymous request issues **no saved-state query at all**. Asking which of these targets nobody has saved would require inventing a subject.

### 8. Which surfaces carry it, and the one that deliberately does not

Carried: `GET /v1/search/providers`, `GET /v1/providers`, `GET /v1/providers/:id`, `GET /v1/providers/:id/services`.

Not carried: `GET /v1/me/provider` and every mutation response, which are the professional's own management surface rather than a page anybody discovers from. They return the `null` default and cost no query.

Also not carried: the **nested `services` array inside a search result**. A service's saved state is served by `GET /v1/providers/:id/services`, where the batch is bounded by one professional's catalogue. Hydrating every service of every result would make the batch grow with a product nobody controls, and a capped batch would report saved services as unsaved — a wrong answer where an absent field is an honest one.

### 9. No migration

The saved-state read is `user_id = $1 AND ((target_type = 'professional' AND target_id IN (…)) OR (target_type = 'service' AND target_id IN (…)))`, which is two range scans on the existing `uq_wishlist_saved_items_user_target (user_id, target_type, target_id)` inside one statement. The availability read is by primary key on `provider.professionals` and `provider.services`.

The type-scoped form is deliberate: a bare `target_id IN (…)` cannot seek past the index's first column and degrades to a scan of the customer's rows.

### 10. Nothing new is emitted

No event, no outbox table, no `ServiceName` entry, no notification, no analytics fact, no ranking signal, no sweep.

A notification that a saved target became unavailable would disclose a third party's status change; one to the professional that somebody saved them would publish a private list. Both were already refused by ADR-033 §10 and `V32-DEC-021`, and this story is where the temptation actually arises — because for the first time the platform *computes* that a target went away.

It is a computation, not a fact the system is told about, and it is discarded at the end of the response.

## Consequences

- A saved target's state is correct within one request of the platform acting, rather than within one index-drain of it.
- A page of saved items costs a bounded number of queries that does not grow with the page, and the bound is measured rather than asserted.
- `search` and `provider` each gain one required port. Any composition of either module must bind it, including the pg-mem test harness — which is why that harness now imports the real bindings rather than a stub.
- The public professional shape and the search result shape each gain one additive field. No key was removed or renamed, so no existing client is affected.
- A future third target type needs: the contract's `WISHLIST_TARGET_TYPES`, a migration widening `ck_wishlist_saved_items_target_type`, a branch in `availableTargets`, and a branch in `savedTargets` — which is a visible, reviewable set of edits rather than a silent default.

## What is deliberately not decided here

- **Any frontend or design artifact** — Story #10.
- **Saved state on nested search services** — §8, refused on the batching argument, and additive if the shape ever needs it.
- **Public save counts, popularity, ranking contribution, recommendations** — refused by `V32-DEC-021`, and structurally unrepresentable in the ports this ADR introduces.
- **Businesses and portfolio items as targets** — refused by `V32-DEC-020` and unchanged.
