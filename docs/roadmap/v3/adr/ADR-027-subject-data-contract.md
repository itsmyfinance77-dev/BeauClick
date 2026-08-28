# ADR-027: Privacy as a Self-Registering Per-Module Contract, Enforced Against the Database Catalogue

**Status:** Accepted — implemented in V3.1 Phase E.
**Date:** 2026-08-28.
**Relates to:** ADR-011 (repository architecture — no domain imports another), ADR-017 (financial isolation and the append-only ledger), ADR-009 (financial ledger), `V3_DOMAIN_BOUNDARIES.md` §admin/privacy, `V3_SECURITY_MODEL.md` §3.
**Closes:** `GAP-22` (no self-service export or deletion for anyone) and `GAP-21` (no deletion cooldown or grace period), both open since the V3.1 gap reconciliation and both classified there as the item "with actual regulatory weight".
**Does not close:** what happens to a *business* whose owner erases their personal account. See "What is still open".

## Context

Fourteen domains own data about a user. The platform had no export endpoint, no deletion endpoint, and no anonymization path at all: `identity.users.deleted_at` existed as a column that nothing ever set, and `confirm_deletion` existed only as an OTP purpose with no flow behind it.

The obvious implementation is a privacy service that reads every module's tables and knows what to do with each. V2 built exactly that, and `PRIV-06` records what it cost: a hardcoded call list inside the privacy plugin that went stale the moment a new plugin started storing user data — and went stale *silently*, because an export that quietly omits a module is byte-for-byte indistinguishable in shape from a complete one. Nobody finds out until a regulator or a user asks why their data is not in the file.

Two constraints made the V2 shape unavailable here in any case. ADR-011 forbids a service from reading another service's tables, so a privacy service holding fourteen repositories would fail lint. And ADR-017 gives the application role no privilege whatsoever on `financial.*`, so a single-connection reader could not see the ledger even if it were allowed to.

## Decision

### 1. The direction is inverted: each module answers for its own data

`libs/subject-data` defines `SubjectDataContract` — `exportSubjectData(manager, userId)` and `eraseSubjectData(manager, userId, tombstone)` — and every data-owning module implements it. `privacy` orchestrates and knows nothing about any domain's tables.

This is the shape `V3_DOMAIN_BOUNDARIES.md` §admin/privacy already specified ("a thin orchestrator calling every module's own typed contract, self-registered"). What this ADR adds is making *self-registered* mean something enforceable.

It is also correct on the merits and not only on the boundaries: only `booking` knows that a cancellation reason is customer-authored prose while a slot's status is not, and only `loyalty` knows that a points entry's `reason` is a platform-written enum rather than something a user typed.

### 2. Coverage is asserted against `pg_tables`, at boot, and it fails startup

The registration list still exists — it is assembled in `apps/api/src/composition/privacy-composition.module.ts` — and it is *not* what the guarantee rests on. `SubjectDataCoverageService` reads the real database catalogue at boot and requires **every table in every non-system schema to be claimed by exactly one contract**, as one of three dispositions:

- `subject_data` — holds data about an identifiable subject;
- `retained` — holds subject data that must survive erasure, **with a stated reason**;
- `no_subject_data` — holds nothing about any person, **with a stated reason**.

A migration that creates a table nobody claimed fails startup. So does a stale claim for a table that no longer exists, a table claimed by two modules, and a `no_subject_data` claim on a table carrying a subject-shaped column (`user_id`, `customer_id`, `*_by`, `*_user_id`, `phone`, `email`).

Three choices inside that are load-bearing:

**`pg_tables`, not `information_schema`.** The latter is privilege-filtered, and the application role holds nothing on `financial.*` — so an `information_schema` universe would silently have excluded the ledger, the single most legally sensitive table in the platform, from the check meant to guarantee nothing is missed.

**Total coverage, not "the tables with personal data in them".** A partial rule needs somebody to decide per table whether it qualifies, and a table nobody classified is then absent rather than flagged — indistinguishable from one that was considered and cleared. Requiring every table to be claimed makes the decision mandatory and the omission loud. The cost is one line per table, paid once.

**No schema is excluded.** `public.schema_migrations` is claimed by `privacy` explicitly, because excluding a schema is how the first genuinely unclaimed table gets in.

The residual risk is stated rather than hidden: the subject-column heuristic is a naming convention, and a new table could evade the `no_subject_data` cross-check by inventing a column name no other table in the platform uses. That is a much smaller surface than a per-table inventory, and it is recorded in `coverage.ts`.

### 3. Erasure is anonymization with referential integrity, and the model is one sentence

**Destroy the identifying link and the free text; leave rows that are nothing but ids.**

`identity` destroys the phone number, the display name, the sessions, and the one-time codes — the only material in the platform that identifies a human directly. Every module destroys prose the subject authored, because writing is identifying in a way a number is not. Everything else stays, because once the identity it points at no longer exists, `bookings.customer_id` describes an appointment rather than a person — and deleting it would corrupt a professional's business records and the ledger's referential ground for no privacy gain.

Three consequences follow, and each is a decision rather than a detail:

- **A review's rating survives; its comment does not.** The rating is a fact about the professional that other customers and the ranking formula rely on; silently rewriting a provider's average because an unrelated person closed their account would be the wrong trade.
- **`journey` deletes rather than anonymizes.** Beauty profiles, goals, and timelines are single-party and referenced by nobody, so retaining them would be keeping personal data for no reason. Applying the platform's anonymization default there out of consistency would be the wrong answer arrived at by rule-following.
- **`analytics.events` keeps its `actor_id`.** Nulling it looks like more privacy and is not: it would silently change already-closed reporting periods on the next rollup re-run, while gaining nothing, because the id already points at an anonymized identity.

### 4. One transaction, with one disclosed exception

Export and erasure both run inside a single transaction on the application DataSource, so an export is one consistent snapshot and there is no half-erased subject for a retry to reason about.

Two things sit outside it, both physically:

- **`financial`** is a separate connection under the append-only role. It reads through `MyFinanceService` (which resolves the party from the session id, per `GAP-05`) and writes nothing during erasure — the role has no `UPDATE` or `DELETE`, so the database enforces this contract's honesty rather than merely agreeing with it.
- **Object storage has no transaction.** `media` marks its rows deleted inside the transaction; the bytes are purged *after* it commits, by `PrivacyErasureCompleter` in the composition root. The ordering is the safe one: a crash between them leaves orphaned bytes whose rows already say they are gone, where the reverse would let a rolled-back erasure destroy a professional's portfolio while every row still claimed the images existed.

### 5. The grace window is what makes "cancel restores everything" true by construction

`GAP-21`. An erasure request records `execute_after` and executes only when a sweep finds it due. Cancelling inside the window restores nothing **because nothing was destroyed**. The alternative — erase immediately, keep a backup to undo from — would require keeping the erased data around to honour the undo, which defeats the erasure.

The default is seven days (`PRIVACY_ERASURE_GRACE_HOURS`), environment-tunable and recorded as an open business decision under `GAP-10`. A zero or unparseable value falls back to the default rather than propagating: a grace window of zero is not a short window, it is deletion with no way back arrived at by clearing an environment variable.

The sweep is the *only* path by which an erasure executes. There is no route, no administrative action, and no event consumer that can bring one forward.

### 6. The export document lives in PostgreSQL, not in object storage

`privacy.export_payloads` holds the document as JSONB, in a table separate from `privacy.data_requests`.

The separation is a security boundary rather than normalization: an operator lists requests, and **no operator may ever read a payload** (Phase E's security note, unqualified). Putting the payload in a different table makes that structural — a route reading a request row cannot return a document by accident, because the document is not on the row it read.

Object storage was rejected for the delivery path. A presigned URL to a complete personal-data export is a bearer credential that survives being forwarded, logged by a proxy, or left in a browser's history. Serving through an authenticated route means the subject's session is re-verified on every byte, which is what the requirement actually asks for. The payload expires and is **destroyed**, not merely made unreachable.

## Consequences

**Good.**

- Adding a module that stores user data now *cannot* be forgotten: the application refuses to start. The failure that closed V2's `PRIV-06` by discipline is closed here by mechanism.
- Every retention decision in the platform is written down, in code, next to the module that owns it, with a reason — and the reasons are surfaced to the subject in their own export document.
- `privacy` depends on no domain, so `@nx/enforce-module-boundaries` checks the arrangement rather than trusting it.

**Costs, accepted.**

- Sixteen contracts to maintain, one per data-owning module. Each is small, and the boot check is what keeps them honest.
- A new table requires a one-line classification before the application will start. That is the point, and it is the cost.
- The financial section of an export is read outside the transaction's snapshot, so it is consistent within the application database and eventually consistent with the ledger. A distributed transaction to close a few milliseconds on a read-only report was not worth the machinery; the limitation is disclosed in `financial-subject-data.contract.ts`.

**Rejected alternatives.**

- *A privacy service that reads every module's tables* — V2's shape. Fails ADR-011, cannot see `financial`, and reintroduces `PRIV-06` exactly.
- *A hand-maintained list of data-owning modules* — the stale-list failure this ADR exists to eliminate.
- *Entity metadata as the coverage universe* — misses tables with no entity class (join tables, projections created by migration) and misses `financial` for the privilege reason above.
- *Erasure by deletion* — breaks the append-only ledger's referential integrity and is forbidden by `V3.1_PRODUCT_ROADMAP.md` §9 in any case.

## What is still open

- **What happens to a business whose owner erases their account.** Three answers are defensible (close it, leave it unassigned, transfer to a manager), each with consequences for staff and for customers holding bookings. Until it is decided, `business.businesses` is retained and the erased owner's staff membership is set to `removed` — the option that destroys nothing and misrepresents nothing. Recorded in `business-subject-data.contract.ts` and in the phase report.
- **The grace-window and export-TTL figures** (`GAP-10`), visible as provisional rather than silently settled.
