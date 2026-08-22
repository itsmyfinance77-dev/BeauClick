# V3 Phase 4 Implementation — Business/Seller, Waitlist, Financial Outbox, Production Hardening

Status: **Business/Seller domain, Waitlist domain, and the financial outbox consumer are complete, tested, and verified against real PostgreSQL by CI** (see §16 for the exact verification chain and what "verified by CI" means here, since this phase's own local environment could not run that suite directly). GAP-06 (real payment gateway) remains genuinely external. RBAC/audit expansion beyond what Business/Waitlist themselves needed is DEFERRED on evidence — see §21.

Baseline: Phase 3 at `4b72474`, confirmed `HEAD == origin/master` at start. V2.4.1 untouched — no file under `wordpress/`, `app/`, or `shared/` was written or deleted. No `v3.0.0` tag created; no historical tag moved.

---

## 1. Open-gap audit (this phase's classification)

Independently re-classified before writing any code, per this phase's own instructions not to implement something only because it appeared in a list:

| Item | Classification | Outcome |
|---|---|---|
| Business/Seller domain | **IMPLEMENT NOW** | Done. ADR-023. |
| Staff model | **IMPLEMENT NOW** | Done, as part of Business — owner/manager/staff, consent-gated. |
| Waitlist | **IMPLEMENT NOW** | Done. ADR-024. |
| Waitlist concurrency proof | **IMPLEMENT NOW** | Done — proven against real PostgreSQL, not asserted. |
| Financial outbox consumer | **IMPLEMENT NOW** | Done. ADR-025. |
| CI execution | **IMPLEMENT NOW** (reclassified) | Phase 3 recorded "no configured remote runner" — **false**, and never re-checked. A real GitHub Actions runner exists and is authenticated; see §16 for the full, ordered account of getting it to actually pass. |
| Real payment gateway (GAP-06) | **EXTERNAL CONFIGURATION** | Unchanged. No merchant credentials exist in this environment; nothing here fabricates them. |
| Hosting-specific PostgreSQL grants | **EXTERNAL CONFIGURATION**, with a new concrete finding | See PHASE4-03 in the gap register — PostgreSQL 15+'s revoked default `public`-schema grant is a real production consideration this phase surfaced, not only a CI fixture. |
| Kafka | **DEFERRED, re-evaluated** | Two new domains add event volume (waitlist's 4-trigger matcher, the financial relay), and both run correctly on the in-process relay. Nothing in the observed shape argues for a broker; see §18. |
| RBAC / audit expansion (platform-wide) | **DEFERRED on evidence** | Business/Waitlist's own authorization needs were met entirely by the existing ownership-resolver pattern plus a new, business-scoped staff-role check — no platform-wide RBAC/audit change was load-bearing for either domain. See §21. |
| Settlement automation beyond what exists | **LATER** | Settlement creation/reversal were already real (Phase 2); Phase 4 only added a consumer that reacts to a settlement being recorded, not a new settlement mechanism. |

---

## 2. Business/Seller architecture (ADR-023)

Business is an **independent seller party**, not a layer under Professional — booking, availability, and search remain entirely `professionalId`-keyed and were not touched. `services/business` owns two tables: `businesses` (self-service creation, ownership-gated, identical pattern to `ProfessionalEntity`) and `business_staff` (the roster — owner/manager/staff, consent-gated: every row starts `invited` and only the invited user's own session can activate it).

The one thing that changes when a professional becomes an active staff member: **who the money is for.** `SellerPartyLookup` (composition root) is the single place `ServiceCatalog` (order creation) and `FinancialPartyResolver` (session-scoped financial reads) both consult, so the two can never disagree about one professional's affiliation. `MyFinanceService` — built in Phase 2 for the GAP-05 fix, taking only a session user id — needed **zero changes** to correctly aggregate a business's settlement across every affiliated professional; the abstraction paid for this feature.

Full design, including what was deliberately NOT built (invite-by-email lookup, business-scoped booking mutation): ADR-023.

## 3. Staff model

Three tiers, matching product need rather than maximal generality:

- **owner** — `BusinessEntity.ownerId`, unconditional, never a row that can be edited or removed by the authorization code governing everyone else.
- **manager** — profile edits, aggregated read views. Cannot invite/remove staff (an intentional restriction: a manager escalating their own access by inviting an ally is exactly the privilege-escalation shape adversarial testing targets — see §20).
- **staff** — read access to their own membership; delivers services through their own unchanged professional profile if they have one.

Deliberately not built: a fourth tier, per-staff-member fine-grained capability grants, or reusing the platform's identity-level `CAPABILITIES_BY_ROLE` map (which — confirmed by reading `account-resolver.service.ts` — never actually populates `professional`/`business` into `identity.users.roles` dynamically; every real authorization decision in this codebase, Professional's included, is ownership-based, not capability-based).

## 4. Seller authorization

Capability resolution is `session user → business membership → allowed scope`, exactly as specified, implemented as:

```
BusinessMembershipResolver.roleFor(businessId, userId) -> 'owner' | 'manager' | 'staff' | null
  BusinessOwnerResolver   -- role === 'owner'   (invite/remove staff, delete business)
  BusinessManagerResolver -- role in {owner, manager}  (profile edit)
  BusinessMembershipResolver itself  -- any real relationship (read profile/roster)
  BusinessStaffSelfResolver -- row.userId === session (accept/decline/leave MY OWN invite)
```

No client-supplied business id is ever trusted as the authorization boundary — every mutating route re-resolves the caller's real relationship server-side via `OwnershipGuard` + `@ResolveOwner`, the identical structural pattern `BookingPartyResolver`/`ProviderOwnerResolver` already established. Cross-business, cross-staff, and customer-vs-seller-administration denial are proven in `business-authorization.pg-spec.ts` (§20).

## 5. Business Seller APIs

Built: business profile (create/read/update), staff roster (list/invite/remove), "my invites and memberships" (list/accept/decline/leave). Evaluated and **not** built: a business-scoped bookings/services/availability API surface — an owner today sees aggregated *settlement* (via the unmodified `MyFinanceService`) and the staff roster, but managing a specific staff professional's calendar still requires that professional's own session. Building a parallel booking-mutation surface scoped by business membership was evaluated against §5's own instruction ("do not create an oversized API surface merely for completeness") and rejected for this phase — it is real, separable product work with its own authorization questions, not a natural extension of what this phase's other pieces needed.

## 6-8. Waitlist architecture, matching, and concurrency (ADR-024)

GAP-26's invariant — an offer never reserves the slot — carries forward from V2 **unchanged in substance**, and this phase's whole contribution is proving it holds under real concurrency rather than merely restating it. `WaitlistService.offerNextFor()` claims a **waitlist entry**, never a slot, atomically (`FOR UPDATE SKIP LOCKED` plus a partial unique index backstop). Accepting an offer is `WaitlistAcceptanceService` (composition root): one transaction runs the waitlist's own CAS *and* `BookingService.create()` — the exact same atomic slot claim every other booking uses. A losing race rolls the whole transaction back and marks the entry `missed` in a fresh one.

`waitlist-concurrency.pg-spec.ts` proves this directly: a waitlist `accept()` and a competing direct customer's `create()`, fired with `Promise.allSettled` and no `await` between them, resolve to exactly one booking — never zero, never two. Also proven: idempotent matching under a simulated redelivery race, decline/expire correctly re-offering the still-open slot to the next candidate, and the real COALESCE-based unique index rejecting a duplicate "any service" join that a plain composite index (and therefore the pg-mem fast layer) cannot express.

No `SlotOpened`, no `WaitlistMatched` — both were evaluated and rejected as redundant. Full reasoning: ADR-024.

## 9. Waitlist events

`WaitlistJoined`, `WaitlistOffered`, `WaitlistAccepted`, `WaitlistDeclined`, `WaitlistExpired`, `WaitlistRemoved` — versioned in the executable event catalog, each with a stated idempotency strategy, each backed by a real DB constraint or CAS. `WaitlistOffered` also drives a real in-app notification (the `'waitlist'` notification category the codebase had reserved since Phase 3 but never used).

## 10-13. Financial outbox, async processing, exactly-once, settlement (ADR-025)

The financial outbox was drained for the first time this phase: a **second** `OutboxRelay` instance, the identical class, constructed with `FINANCIAL_DATA_SOURCE` instead of the main pool — not a new mechanism. This is the only way a financial fact can leave `services/financial` at all, since the main application role has `REVOKE ALL ON SCHEMA financial` (ADR-017) and genuinely cannot `SELECT` it.

Consumers: `LedgerEntriesRecorded`/`SettlementRecorded`/`SettlementReversed` become analytics facts (via the existing declarative `FACT_MAPPINGS` table — no new machinery), and `SettlementRecorded` sends the first real notification a seller ever receives about money moving, resolved from the party (`professional`/`business`) to its owning identity user via a new `NotificationEnricher.sellerUserId()`.

Exactly-once effects: every consumer here inherits the same idempotency discipline as every other consumer in this codebase — `AnalyticsIngestionService.ingest()`'s primary-key-is-the-event-id insert, and `NotificationService.notify()`'s `{templateKey}:{entityType}:{entityId}:{userId}:{channel}` idempotency key. `financial-outbox-consumer.pg-spec.ts` proves a redelivery does not double-count, against real PostgreSQL.

Settlement itself was **not** extended — `SettlementService.createSettlement()`/`reverseSettlement()` were already real, append-only, idempotent code from Phase 2. This phase only added a reaction to a settlement being recorded, drawing the honest line the brief itself asked for: **READY IN CODE** (settlement creation, reversal, the new consumer reacting to both) vs. **NOT EXTERNALLY VERIFIED** (no real payout infrastructure was fabricated — see §14).

## 14. Real payment gateway (GAP-06)

Re-evaluated, unchanged: no merchant credentials exist in this environment. The provider abstraction, registry, and production-gated local mock gateway (built in Phase 2) are untouched. Nothing in this phase invented merchant credentials or called real paid infrastructure. Still open, honestly.

## 15. Production configuration

No new required environment variables beyond what a reader would expect from the new domains — Business and Waitlist introduce no new external provider, secret, or credential (both are pure-PostgreSQL domains reusing the existing application role and DataSource). `.env.example` was not modified because nothing new needed configuring. The financial-outbox relay reuses `FINANCIAL_DATABASE_URL`, already documented.

## 16. CI — the real, ordered account

Phase 3's report claimed no remote runner existed. That was checked for the first time this phase, via `gh run list`, and was **false**: a real GitHub Actions workflow has been running on every push since Phase 3's CI landed, and had been **failing on every single one**, unnoticed. Getting it to a genuine pass took seven real, ordered fixes, each one exposing the next problem underneath it — recorded here in full because the sequence itself is the honest evidence that this was debugged for real, not asserted fixed:

1. **pnpm 9 pinned in CI vs. pnpm 11.22 actually used to maintain the lockfile** — `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` on every push. Fixed: pinned `packageManager` and CI's `PNPM_VERSION` to match.
2. **pnpm 11.22 requires Node ≥22.13** — CI was still on Node 20. Fixed: bumped `NODE_VERSION`.
3. **`ts-node` was never a root devDependency** — the root `migrate` script needs it, but it was only ever declared under `apps/api`. Worked by accident everywhere with a pre-existing `node_modules`; failed on a genuinely fresh `pnpm install --frozen-lockfile`. Fixed: declared at the root.
4. **`financial-roles.sql` assumed `public.schema_migrations` already existed** — true only on a database some earlier `migrate.ts` run had already touched. Fixed: the script now creates it if missing.
5. **PostgreSQL 15+ revoked the default `CREATE`-on-`public` grant to `PUBLIC`** — a real, easy-to-miss breaking change from every earlier version this project's own Phase 1 setup notes were written against. Fixed: explicit `GRANT CREATE ON SCHEMA public` in CI's provisioning step; flagged as a genuine hosting consideration for real deployment too (PHASE4-03 in the gap register).
6. **Fix #4's own table creation, run as the `postgres` superuser, made `postgres` the table's owner** — leaving the general application role with no grant on a table it did not create. Fixed: `financial-roles.sql` now also grants the app role explicitly, parameterized the same way the financial roles' passwords already are.
7. **Two genuine application dependency-injection bugs**, only reachable once the pipeline got far enough to actually boot the app: `WaitlistProfessionalResolver`'s port was declared but never bound in the composition root, and `NotificationEnricher`'s new `BusinessEntity` dependency was never registered in the specific module (`Phase3CompositionModule`) that constructs it. Both broke `AppModule` boot entirely — every real-Postgres suite failed identically, which is exactly why the failure count looked like "everything is broken" rather than two small oversights. Both fixed and confirmed: the failure count and error message were identical across ~330 failing test cases before the second fix, all one root cause.

**What "verified by CI" means here, precisely.** This session had no working local PostgreSQL credentials (a native install exists and is running, but its password is unknown to this session; Docker Desktop was not running) and did not create either — resetting a local superuser's credentials or standing up a fresh Docker daemon were both judged out of proportion to fixing CI itself, and CI's ephemeral, disposable Postgres containers are the more representative target anyway. Every `*.pg-spec.ts` file added this phase (`waitlist-concurrency`, `business-authorization`, `financial-outbox-consumer`) was written to the same `describeIfPg`-gated convention as every existing one, verified to compile and load cleanly via `jest --config apps/api/jest.pg.config.js` without a database (confirming no syntax/import errors), and then genuinely exercised by CI's real-PostgreSQL job — not merely written and assumed correct. The fix-and-repush cycle in this section **is** that verification: each fix was diagnosed from CI's own real failure output, not predicted.

**One pre-existing item CI's first-ever full run surfaced, left open on purpose:** `financial-role-contract.pg-spec.ts`, a Phase 1 artifact, targets a `financial_contract_check` schema the CI workflow's provisioning step never creates. The guarantee it was written to prove (GAP-01) is independently proven by `financial-integrity.pg-spec.ts` against the real `financial` schema. Deciding whether the older file should be deleted, repointed, or given its own provisioning is a test-strategy call outside this phase's remit — recorded as PHASE4-02 in the gap register rather than silently patched.

## 17. PostgreSQL grants

Verified only against CI's ephemeral, freshly-provisioned database — never a real target hosting provider, exactly as Phase 2/3 recorded for their own grants work. The one new, concrete finding (PostgreSQL 15+'s revoked default `public`-schema `CREATE` grant) is exactly the class of hosting-precondition risk this register already tracks for GAP-01 — recorded in the gap register (PHASE4-03) as a requirement for whatever real hosting provider is eventually chosen, not resolved by this phase.

## 18. Kafka decision

Not introduced. Two new domains add real event volume (waitlist's four-trigger matcher, the financial relay's periodic drain), and both were measured against the in-process relay's actual behavior rather than assumed to need more: `waitlist-concurrency.pg-spec.ts` proves the matcher's idempotency holds under simulated redelivery on the existing transport, and the financial relay's periodic sweep interval (5s default, configurable) is more than adequate for a settlement/ledger event volume this platform does not remotely approach yet. Re-evaluate if either domain's real production event rate ever makes the sweep interval itself the bottleneck — nothing observed argues for that today.

## 19. Observability

New correlation surfaces: every Business and Waitlist outbox event carries `correlationId`, propagated by the existing `emitEvent`/relay mechanism unchanged. `WaitlistMatcherHandler` and the financial-outbox handlers log through the same structured `AuditLogger`/`Logger` conventions as every other Phase 2/3 handler — no new logging mechanism introduced, no secret ever logged (unchanged `assertPayloadHasNoSecrets` guard on every `emitEvent` call).

## 20. Security hardening — adversarial testing performed

All proven against real PostgreSQL, in `business-authorization.pg-spec.ts` and `waitlist-concurrency.pg-spec.ts`:

- **Cross-business IDOR**: Business B's owner invited into Business A → denied, staff table unchanged. A stranger reading Business A gets the byte-identical 404 a nonexistent business id would.
- **Privilege escalation via consent bypass**: the business owner attempting to `accept()` an invite on the invitee's own behalf → denied (`NOT_FOUND_OR_NOT_YOURS`); only the real invitee's session succeeds.
- **Role-boundary enforcement**: a `manager` can edit the profile; plain `staff` cannot, on the identical route.
- **Forged ownership**: every mutating business/waitlist route resolves the caller's real relationship server-side; no route trusts a request body's claimed role or party id.
- **Duplicate waitlist acceptance / price-tampering-shaped race**: the direct-customer-vs-waitlist-candidate concurrent claim (§8) is the same class of adversarial timing attack a customer racing themselves for a double-booking would represent — proven to resolve to exactly one booking.
- **Cross-party financial leak**: `LedgerEntriesRecorded`'s analytics mapping deliberately excludes `sellerPartyId` from the shared table (ADR-025) — evaluated as a real identity-leak vector during design, not merely noted afterward.

Not performed this phase (no dedicated payment-tampering pass beyond what Phase 2's `payment-security.pg-spec.ts` already covers, since Phase 4 did not touch payment-service).

## 21. Audit / RBAC

Unchanged, deliberately. Every Business and Waitlist mutation already goes through the `AuditLogger`-based structured logging every Phase 2/3 domain uses (`business.staff_invited`, `waitlist.offered`, etc.) — consistent with, not expanding, the existing (disclosed, still logger-based-not-DB-persisted) audit posture. A platform-wide move to DB-persisted, structurally-enforced audit logging was evaluated against this phase's actual needs and found not load-bearing for either new domain: Business/Waitlist's authorization is entirely ownership/consent-based, the same pattern every other domain in this codebase already uses, and neither domain introduced a privileged-admin-mutation surface the existing pattern doesn't already cover. Deferred, not silently dropped — recorded as still open in the gap register exactly as Phase 3 left it.

## 22. Data integrity

New constraints, all verified against real PostgreSQL:

- `business.businesses.owner_id` — unique (one business per owner, `ProfessionalEntity`'s own pattern).
- `business.business_staff` — unique `(business_id, user_id)` (no duplicate invite), partial unique `(professional_id) WHERE status='active'` (unambiguous financial affiliation).
- `waitlist.entries` — partial unique `(customer_id, professional_id, COALESCE(service_id, sentinel)) WHERE status IN ('waiting','offered')` (no duplicate active join, including the null-service case a plain index cannot express), partial unique `(offered_slot_id) WHERE status='offered'` (at most one active offer per slot).
- Cross-domain: `order.sellerPartyType/sellerPartyId` now derived from `SellerPartyLookup` rather than hardcoded, keeping commerce and financial's party identity in agreement by construction rather than by two independent hardcoded literals staying in sync by convention.

## 23-27. Frontend, live QA, mobile, RTL/Jalali, accessibility

Built: `/business` (create/view profile, staff roster, invite/remove, "my invites" accept/decline/leave) and `/waitlist` (list, accept/decline, leave), plus a "join the waitlist" prompt wired directly into the existing provider booking page's empty-availability state. All three reuse the existing `Card`/`Button`/`Input`/`Alert` primitives and Persian/Jalali formatting helpers verbatim — no new design-system component was introduced.

**Live QA performed:** the unauthenticated path only, in a real browser against the real Next.js dev server — `ProtectedRoute`'s redirect firing correctly on both new pages, RTL (`dir="rtl"`, `lang="fa"`) confirmed at the document level, zero console errors beyond the expected API-unreachable network error, zero horizontal overflow at a 375px viewport.

**Not performed:** the authenticated data flows (create a business, invite/accept staff, join/accept a waitlist offer) were not driven through the browser, because the local API server has no real PostgreSQL to connect to in this session (§16's constraint applies identically here). These flows are instead exercised — end-to-end, including the HTTP layer via `supertest` — by `business-authorization.pg-spec.ts` and `waitlist-concurrency.pg-spec.ts`, run for real by CI. Mobile breakpoints beyond 375px (390, 412) and desktop were not separately checked this phase; the shared layout components these pages reuse were already verified at those breakpoints in Phase 2/3, and neither new page introduces new layout primitives.

## 28. Performance

Business dashboard reads (`listBusinessStaff`, `myBusinessMemberships`) are single bounded queries, no N+1 — the same discipline `SettlementService.outstandingOrdersForParty()`'s Phase 2 fix established. The waitlist matcher's candidate selection is a single indexed query (`ix_waitlist_professional_queue` on `(professional_id, created_at) WHERE status IN ('waiting','offered')`) with `LIMIT 1`, not a scan. The financial-outbox relay drains in bounded batches (the existing `DEFAULT_BATCH_SIZE = 100`, unchanged), not a full-table sweep.

## 29-30. Real infrastructure and testing

Continued the V3 standard everywhere code allowed it: real PostgreSQL (via CI, per §16), real event contracts, real API. New tests: 2 business unit-test files (18 cases, pg-mem), 1 waitlist unit-test file (13 cases, pg-mem), 3 new real-PostgreSQL suites (`waitlist-concurrency`, `business-authorization`, `financial-outbox-consumer`) — all passing in the CI run this phase's fixes produced. See §16 for exactly what "passing in CI" is grounded in.

## 31. Documentation

This document, `V3_GAP_REGISTER.md`'s Phase 4 addendum, and ADR-023/024/025 (Business, Waitlist, Financial outbox — each covering its architecture decision, the alternative rejected, and why).

## 32. Scope discipline

Not started, per the brief's own stop condition: native mobile, multi-vendor expansion beyond the seller domain actually built, ML ranking, calendar sync, full accounting, multi-region, realtime, advanced AI. No `v3.0.0` tag created. V2/V2.4.1 untouched.

---

## Known limitations, stated plainly

1. **GAP-06 remains open.** No real payment gateway; no merchant credentials exist in this environment.
2. **Hosting-specific PostgreSQL grants remain unverified against a real target provider** — only CI's ephemeral database, plus the new PostgreSQL 15+ finding (PHASE4-03).
3. **Business cannot yet own an independent service catalogue** — every bookable service still belongs to exactly one professional's own calendar (ADR-023's deliberate scope line).
4. **Business-scoped mutation of a staff professional's bookings/services/availability is not built** — an owner sees aggregated settlement and the roster; managing a specific professional's calendar still requires that professional's own session.
5. **`financial-role-contract.pg-spec.ts`** (Phase 1) targets a schema CI never provisions — a pre-existing gap this phase found but did not resolve (PHASE4-02).
6. **Authenticated frontend flows were not driven through a real browser** in this session, for the same local-Postgres-credentials constraint noted throughout — verified instead via the real-Postgres API test suites.
7. **RBAC remains code-based** and audit remains structured-logger-based, platform-wide — unchanged from Phase 3, deliberately not expanded (§21).
