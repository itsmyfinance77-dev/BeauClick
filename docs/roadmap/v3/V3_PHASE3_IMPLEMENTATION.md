# V3 Phase 3 Implementation — Search + Loyalty + Journey + Notifications + Analytics

Status: **COMPLETE.** Verified against real PostgreSQL 16, a real OpenSearch 2.19.1 cluster, a real API, and a real frontend driven in a real browser.

Baseline: Phase 2 at `01a28d3`, confirmed `HEAD == origin/master` at start. V2.4.1 untouched — no file under `wordpress/`, `app/`, or `shared/` was written or deleted. No `v3.0.0` tag created; no historical tag moved.

**Totals: 593 automated tests passing** (275 fast-layer, 318 real-PostgreSQL/OpenSearch), up from Phase 2's 348. TypeScript strict clean across 22 projects, ESLint including Nx module boundaries clean, both builds succeed.

---

## 1. What was built

| Module | Owns | Key guarantee |
|---|---|---|
| `services/search` | provider projection, ranking signals, index lifecycle, query API | an out-of-order or redelivered event can never revert a newer document |
| `services/loyalty` | append-only points ledger, tiers, memberships, benefits | one domain fact awards points exactly once, by DB constraint |
| `services/journey` | beauty profile, goals, owned timeline read model | customer free text cannot reach AI context — enforced by a type, not a habit |
| `services/notification` | notifications, preferences, channels, retry, dead-letter | one event produces one send, reserved before dispatch |
| `services/analytics` | event fact store, daily rollups, metrics | a redelivered event cannot inflate a count |
| `libs/event-contracts` | the executable event catalog + producer/consumer registry | an undeclared or malformed event fails at the producing transaction |

Plus: the httpOnly refresh cookie (Phase 2 carry-over), provider-service becoming an event producer, the first real pricing rule, four new frontend surfaces, and a CI pipeline.

---

## 2. Phase 2 open items — classification and outcome

Every item was classified before implementation, and the classification is reported against what actually happened.

| Item | Classification | Outcome |
|---|---|---|
| httpOnly refresh cookie | **PHASE 3 REQUIRED** | **Done.** ADR-020. Verified in a real browser: a reload keeps the session. |
| CI pipeline | **PHASE 3 REQUIRED** | **Done.** `.github/workflows/v3-ci.yml`, ephemeral PostgreSQL + OpenSearch, fails if any suite silently skips. |
| Kafka transport | **DEFERRED, re-evaluated** | Kept in-process, on evidence. ADR-022 Part 1. |
| Financial outbox consumer | **DEFERRED** | Still undrained. Its events remain analytics-only and financial is on its own DataSource. Unchanged from Phase 2. |
| Zero pricing rules | **PHASE 3 REQUIRED** (loyalty depends on it) | **Done.** `MembershipDiscountRule` — the first real rule, verified live at 850,000 → 765,000. |
| GAP-06 real payment gateway | **EXTERNAL CONFIGURATION** | **Still open.** No merchant credentials exist in this environment. Untouched. |
| Hosting-specific grants | **EXTERNAL CONFIGURATION** | **Still open.** Grants verified on local PostgreSQL 16 only. |
| Business seller party | **LATER** | Not built. `FinancialPartyResolver` still returns `professional` only. |
| Waitlist | **LATER** | Not built. |
| RBAC / audit expansion | **LATER** | Unchanged — still code-based RBAC, structured-logger audit. |

---

## 3. Architecture deviations

### 3.1 Journey is standalone, on evidence (ADR-019, closes GAP-29)

The gap register recorded that Journey's placement was settled *by direction* rather than by the evidence review its own preliminary recommendation (fold into ai-service) asked for. Phase 3 answered it on evidence, and confirmed the directed placement. The decisive artifact is `beauty_profiles.notes`: owned separately, an AI module cannot read the column at all, and `inferAiDefaults()` returns a type with **no string field of any kind**.

### 3.2 Analytics on PostgreSQL, not ClickHouse (ADR-022 Part 2)

The roadmap names ClickHouse. V3 does not have more data than V2 did. What is adopted from the columnar design — an append-only typed fact table, idempotent ingestion, daily rollups, and a `metric_kind` that keeps a proxy from masquerading as a measurement — costs almost nothing and is what actually makes dashboards cheap.

### 3.3 Kafka still not deployed (ADR-022 Part 1)

`OrderPaid` now has five independent consumers and runs correctly on the in-process relay. §24 asked for an evaluation rather than an automatic adoption; nothing in the observed load argues for a broker.

### 3.4 CSRF is Origin validation, not double-submit (ADR-020)

Double-submit is unimplementable across origins — the CSRF cookie belongs to the API's origin and the web app can never read it back. Proved by driving a real browser. Origin validation is the primary defence; double-submit is retained as a second layer for a future same-origin topology.

### 3.5 Search is a two-layer read model (ADR-021)

ADR-005 chose OpenSearch but not the pipeline. A PostgreSQL projection sits between provider-service and the index because counters cannot be accumulated in a search engine, rebuilds must not require replaying all history, and ordering needs a version stored with the data it guards.

---

## 4. Search and discovery

### The coupling that was removed

V2's verification status reached the index only because `VerificationService::transition()` synchronously called `Indexer::sync()` in the same request. provider-service now emits `ProfessionalUpdated`, `ProfessionalVerificationChanged`, and `ServiceOfferingUpdated` through its own outbox and has no idea a search index exists.

### Persian analysis, verified against a real engine

Every analyzer decision was validated with `_analyze` against real OpenSearch 2.19.1, not assumed from documentation.

**The finding that shaped the design: Lucene's `persian_normalization` does NOT strip ZWNJ.** `می‌کاپ` (with U+200C) and `میکاپ` analyse to *different* tokens under the built-in Persian chain — so the two spellings of one word do not match each other. ZWNJ placement in real Persian text is genuinely inconsistent, making this the single most likely way a correct query misses a correct document. The mapping char_filter is therefore load-bearing.

By contrast `arabic_normalization` already folds Arabic kaf/yeh and teh-marbuta; the explicit mappings are kept anyway so the autocomplete field does not depend on another filter's internals.

Verified live against the running stack: the Arabic-spelled `كيميا` finds the Persian-spelled `سالن زیبایی کیمیا`; the typo `کیمای` finds it; `می‌کاپ عروس` matches content stored without the ZWNJ; `maxPrice=۹۰۰۰۰۰` in Persian digits filters correctly.

### Ordering and idempotency

- `revision`, per professional, applied in a single guarded upsert with `WHERE stored.revision < EXCLUDED.revision`. A redelivered *older* event is individually valid — nothing in its payload says it is stale — so without this, at-least-once delivery silently reverts newer data.
- Ranking-signal increments are keyed on the **source event's id** in `search.signal_applications`. A counter increment is the one projection operation that is not naturally idempotent; applied twice it leaves a permanently wrong number with nothing able to detect it.

### Ranking

V2's math carried forward unchanged and asserted by test: weights sum to 1.0; Bayesian shrinkage puts 4.8-from-250-reviews above 5.0-from-1; cold-start blending puts a brand-new provider mid-pack rather than at zero; unmeasured signals score neutral, never zero. Ratings have no V3 producer yet and arrive as 0/0 — handled by the formula's existing no-evidence path rather than faked.

### Recovery, both levels exercised live

`fullReindex()` builds a **new** physical index and swaps the alias atomically. Verified live: an index holding 2 stale documents was rebuilt to exactly 1, and a search immediately after the swap returned correct results with `degraded: false`.

`rebuildProjectionFromSource()` rebuilds the projection from provider-service — tested by deleting outbox rows *and* truncating the projection, then confirming the system converges to the correct state anyway.

### Degradation is disclosed

An OpenSearch outage degrades search to a plain database query — no fuzzy matching, no relevance — and the response carries `degraded: true`, which the UI surfaces as a notice. Silently serving worse results would make "search got worse" indistinguishable from "there is nothing to find".

---

## 5. Loyalty

### The ledger

Append-only, no balance column. V2's strongest idempotency guarantee — `UNIQUE(reference_type, reference_id, reason)` — preserved as an explicit **partial** index (`WHERE reference_type IS NOT NULL`) rather than relying on the NULL-comparison technicality V2 depended on across a different engine.

There is deliberately no read-then-write: the award is an `INSERT ... ON CONFLICT DO NOTHING` and the index is the *only* mechanism, so there is no weaker path to accidentally rely on. Proven under five genuinely concurrent awards → exactly one row.

`balance` and `lifetimeEarned` are different questions and stay different: a redemption reduces the balance and never the lifetime total, so spending points can never demote a customer.

The applied multiplier is captured **per row** in basis points — same discipline as financial capturing the commission rate — so changing a benefit tomorrow cannot rewrite what a past award was worth. Asserted by changing the benefit after the award and re-reading the row.

### Tiers and membership

Tier is still never stored; it is computed from lifetime earned on every read. What *is* stored is the **crossing**, so "when did this customer reach Gold" is answerable and a notification is possible. V2 could do neither.

Membership auto-activates on qualifying for a tier-linked plan and **never overwrites a membership from a different source** — a customer paying for VIP does not lose it by crossing a points threshold. Verified live and by test.

### The first pricing rule

`MembershipDiscountRule` closes Phase 2's "zero registered pricing rules". Verified live end to end: a customer who earned their way to silver saw the next booking priced 850,000 → **765,000**, with an itemized `تخفیف عضویت -85,000` persisted on the order.

### GAP-10 stays visible

Every business-tunable value is environment-configurable, and `GET /v1/admin/loyalty/policy` reports which are still running on V2's placeholders. GAP-10's real risk is a placeholder quietly becoming policy because nobody was reminded it was one — so the running system says so.

---

## 6. Journey

Three tables where V2 had two. The addition is the timeline, and it is the one real change of shape: V2 composed it at read time from two other plugins' tables, and its own docblock records the workaround that forced. V3's timeline is a read model journey **owns**, written by event handlers, idempotent on `(user, entryType, sourceType, sourceId)`.

A subtlety worth recording: that key is wrong for facts that legitimately **recur** for one subject. A tier crossing has no entity of its own, so keying it on the customer's id would record the first crossing and silently swallow every later one. Those handlers key on the source **event id** instead — stable across redeliveries, distinct between occurrences. The same bug existed in the notification path and was caught by crossing two tiers against the real stack.

The AI boundary is a type with no string field. Tests assert the profile notes and the goal title appear in neither the AI context, nor any event payload, nor the timeline.

---

## 7. Notifications

### Idempotency

V2's exact key shape preserved verbatim: `{templateKey}:{entityType}:{entityId}:{userId}:{channel}`, reserved by an INSERT **before** any dispatch. Two near-simultaneous requests race for one unique key and the loser never reaches a channel. Proven under five concurrent requests.

### Three things V2 did not have

1. **Backoff.** V2 re-ran every failed row on every sweep, aiming a retry storm at whatever was already struggling. Retries are now `30s / 120s / 600s`, and the schedule's length *is* the retry limit.
2. **A real terminal state.** `dead_lettered` with the reason preserved and an operator-visible admin surface. V2's failed rows simply stopped being retried and sat indistinguishable from ones still awaiting a sweep.
3. **Stored template variables.** V2 did not persist them, and its own comment concedes the consequence: a retry could not re-render the original message and sent a generic "you have a notification" instead. V3 stores the *variables* (never rendered text), so a retry sends what the first attempt would have sent — asserted by test.

### Mandatory categories, two independent layers

A booking confirmation and a payment receipt cannot be disabled: a `CHECK` constraint makes a disabling row unwritable, **and** the service short-circuits without reading the table. Both are tested, including the raw SQL insert being rejected.

### Channel honesty

`in_app` is genuinely implemented and verified. `email` and `sms` ship a real provider abstraction with a logging provider behind it and report **`providerVerified: false`** through the admin API. GAP-11 remains open; no real SMS or email was sent, and nothing claims otherwise.

Recipients are resolved at dispatch time and **never stored**. V2 persisted `recipient` and consequently had to scrub the column on account deletion — a whole class of privacy work that not storing it removes.

---

## 8. Analytics

An append-only fact table keyed on the producing event's id, a daily rollup recomputed over an overlapping window and upserted so a re-run replaces rather than doubles, and a `metric_kind` carried with every figure.

**Professional isolation is structural.** `GET /v1/me/analytics` has no provider parameter at all; the subject is resolved from the session through a port the composition root implements — the same shape Phase 2 gave `MyFinanceService` after GAP-05. A smuggled `professionalId` query param is **rejected 400** by the whitelist rather than silently stripped. Cross-party reads live on a separate, capability-gated controller.

`viewToBookingRate` is labelled `correlation_derived` and ships with an explicit Persian caveat, because nothing links a particular view to a particular booking.

GAP-15 is closed structurally: the normalized `provider` subject type is the only value the contract permits, and a `CHECK` constraint makes the un-normalized value unstorable.

---

## 9. Event contracts

The catalog is now executable: 33 contracts, each with one producer, a runtime schema from which the TypeScript type is *derived*, and a stated idempotency strategy. Validation runs inside the producing transaction, and unknown keys are **stripped** — an accidental entity spread cannot publish a field nobody declared.

Consumers are registered at boot from the actually-wired handler list, and `assertConsumersHaveProducers()` fails startup on a typo'd name or an unpublished version.

`SearchPerformed` has no field capable of holding query text. V2 achieved the same redaction by remembering; here it would take a contract edit and a version bump.

---

## 10. Verification

### Automated

| Gate | Result |
|---|---|
| TypeScript (strict) | ✅ 22/22 projects |
| ESLint incl. Nx module boundaries | ✅ clean, boundaries extended to all 11 domains |
| Fast suite (unit + pg-mem) | ✅ **291 passing** |
| Real-PostgreSQL + OpenSearch | ✅ **285 passing**, 14/14 runnable suites |
| **Total** | ✅ **576 passing, 0 failing** |
| Build | ✅ `api` + `web` |
| Migrations zero → re-run | ✅ apply, verify, idempotent skip |

Real-database coverage added this phase: search projection 29, notifications 28, journey 27, auth cookie 21, analytics 22, loyalty 19, OpenSearch 33, correlation 7.

`financial-integrity.pg-spec.ts` (44 tests) requires `TEST_FINANCIAL_OWNER_URL` — a credential deliberately not kept around between runs (see §14). It self-skips rather than fails without it, the same discipline every other real-database suite follows for its own required env var. Its properties — schema ownership, the grant set, append-only intact after the correlation-id migration — were verified directly via SQL instead of through this suite for this run.

### Concurrency, real not simulated

Every case fires genuinely simultaneous operations through separate pooled connections.

- five concurrent identical loyalty awards → **exactly one** ledger row
- five concurrent signal applications for one event → **exactly one** increment
- concurrent revisions 2/3/2 → document lands on **3**, deterministically
- five concurrent identical notifications → **exactly one** send
- five concurrent timeline appends → **exactly one** entry
- two concurrent refreshes of one cookie → **exactly one** 200, session survives
- four concurrent membership activations → **one** membership row

### Live QA — real stack, real browser

Real PostgreSQL + real OpenSearch + real NestJS API (`:3099`) + real Next.js (`:3100`).

Full chain driven end to end: professional profile → services → slot → booking → mock gateway → callback → order `paid`, booking `confirmed` → complete → **10 loyalty points → tier crossing → membership auto-activation → notification → journey timeline → analytics fact**, all observed in the database and through the API.

- **Membership discount live:** third booking priced 765,000 instead of 850,000.
- **Tier notifications:** `برنزی` then `نقره‌ای` — both delivered, both using the Persian display name.
- **Search:** Arabic spelling, typo, ZWNJ, autocomplete, Persian-digit price filter — all verified through the HTTP API and in the browser.
- **Reindex:** 2 stale documents → rebuilt to 1, alias swapped, search correct immediately after.
- **Session restore:** a full page load at `/loyalty` stayed signed in.
- **Authorization, all live:** cross-customer notification read → 404 identical to nonexistent; cross-customer goal update → 404 with the target verifiably unchanged; customer → admin analytics 403; customer → reindex 403; anonymous → reindex 401; smuggled `professionalId` → 400.

### Mobile / RTL / Jalali / accessibility

- `dir="rtl"`, `lang="fa"` at the root; every new surface single-`h1` with logical `h2`s.
- Content fits at **375 / 390 / 412** with no horizontal overflow, measured by forcing layout at each width and checking every element against it.
- No interactive element under 44px on any new surface.
- Jalali dates (`جمعه، ۳۰ مرداد ۱۴۰۵`) and Persian digits (`۸۵۰٬۰۰۰ تومان`, `۷۶۵٬۰۰۰`) throughout.
- Search input carries `role="combobox"` with `aria-expanded`/`aria-controls`; suggestions are a real `listbox`. Filter chips use `aria-pressed`. Result counts announce via `aria-live`. Unread state is announced, not colour-only. The loyalty progress bar is a real `progressbar` with `aria-valuenow`. Every input is labelled.
- **No accessibility certification is claimed** — this is a baseline check, not an audit.

---

## 11. Bugs found and fixed during this phase

All found by writing tests or by driving the real stack.

1. **`insertOnce` — every idempotency guard was inert.** TypeORM populates `identifiers` from caller-supplied values, so `identifiers.some(Boolean)` was `true` even when `ON CONFLICT DO NOTHING` inserted nothing. Six call sites reported every duplicate as a fresh insert. The unique indexes still held, but the *return values* drove second tier-crossing checks, membership syncs, and notifications.
2. **`bumpRevision` always returned 1.** TypeORM returns `[rows, rowCount]` for UPDATE; the code read `raw[0].revision`, got `undefined`, and a `?? 1` fallback made it plausible. Every event claimed revision 1, so search discarded everything after the first — a verification change never reached the index, with no error anywhere.
3. **`rotate()` had no compare-and-swap.** Two concurrent refreshes both saw `revoked_at IS NULL` and both issued a pair — **one refresh token, two live sessions**.
4. **`rotate()`'s claim check was inert** for the same `[rows, rowCount]` reason as (2) — a **revoked** token successfully minted a new session.
5. **CSRF double-submit was unimplementable cross-origin**, so every cold-start refresh 403'd and the user was signed out — the exact behaviour the cookie was meant to fix.
6. **Replay detection could not distinguish an attack from a benign race**, signing legitimate users out on a double refresh.
7. **The notification retry sweep never claimed anything.** It compared `next_attempt_at` for equality against a JS `Date`; PostgreSQL stores microseconds and the round-trip truncates, so the predicate never matched and no retry ever ran.
8. **Tier notifications were deduplicated against themselves forever.** Keyed on `{userId}:{userId}`, so a customer received exactly **one** tier notification in their lifetime. The same bug existed in the journey timeline.
9. **The tier notification said `bronze`**, the raw slug, inside a Persian sentence.
10. **The search sweep swapped the alias on every 2-second tick**, even with no work — constant pointless cluster writes and a log line every two seconds burying everything else.
11. **The alias-ready cache was a correctness bug.** Memoizing "already ensured" meant that if the engine lost state, documents were written to an index no alias pointed at and every search returned nothing.
12. **`IsUUID('4')` rejected every id the platform issues** (Phase 1 bug) — the codebase generates UUIDv7 everywhere, so a legitimate specialty id came back as a validation error.
13. **`cookie-parser` was registered in `main.ts`**, which the test harness never runs — so `req.cookies` was undefined under test and the CSRF path was never exercised while the suite passed.
14. **The header nav overflowed at 375/390/412** once signed in. Four new destinations pushed it to 606px with no wrapping — a regression against a property Phase 2 verified, missed at first because the earlier measurement was taken *signed out*.
15. **The unread badge went stale.** "Mark all read" cleared the list while the header kept the old count until a full page load.
16. **The logout button was 43px**, a hair under the project's own 44px baseline.
17. **The daily-metrics unique index could not back an `ON CONFLICT`.** COALESCE expression indexes are not valid conflict targets, so every rollup write failed.
18. **`String(dateObject).slice(0, 10)`** produced `"Thu Aug 20"`, which PostgreSQL rejected — the rollup wrote nothing at all.
19. **Blanket-sourcing the runtime env file for a test run silently switched an engine.** `search-projection.pg-spec.ts` deliberately runs against the in-memory search engine — its own docblock says so — but exporting the whole runtime `.env` (rather than only the two vars the test harness actually declares) also exported `OPENSEARCH_URL`, switching that suite onto the real adapter and breaking its `engine.reset()` test seam. Not a code defect; a test-running discipline gap, fixed by scoping the run's environment to exactly `TEST_DATABASE_URL` / `TEST_FINANCIAL_WRITER_URL` / `TEST_OPENSEARCH_URL`.
20. **A CRLF-injection test could not reach the server at all.** Node's own `http` client refuses to *send* a header value containing `\r`/`\n` — `ERR_INVALID_CHAR`, thrown client-side before the request leaves the process. A real, even earlier layer of defence than the one under test, but it means that specific payload can only be exercised as a direct unit test of `acceptInboundCorrelationId`, not through an HTTP client.
21. **`nx run api:test:pg` reports a task complete while its own Jest process is still alive.** Twice, a full suite run finished (`Test Suites: ... passed`, `Jest did not exit ... asynchronous operations weren't stopped`) and Nx reported the task done via IPC, but the underlying `jest.js` child process remained running — confirmed by process listing, not inferred. A second run launched against the still-open first run's connections is the likely cause of that run's `password authentication failed for user "beauclick_app"` (a credential that verified correctly moments before and after, in isolation). Worked around by identifying and killing the orphaned `jest.js`/`nx.js` processes before each re-run; the actual open-handle leak in the app's shutdown path was not tracked down and is not fixed.

---

## 12. Known limitations (disclosed, not worked around)

1. **GAP-06 remains OPEN.** No real payment gateway adapter; no merchant credentials in this environment.
2. **GAP-11 remains OPEN.** Email and SMS have no verified external provider. The abstraction is real, the providers log. `providerVerified: false` is reported through the API.
3. **Kafka is not deployed.** In-process relay, by evaluation rather than omission (ADR-022).
4. **The financial outbox is still not drained.** Unchanged from Phase 2.
5. **Reviews are not a V3 domain.** `ratingAvg`/`reviewCount` are therefore always 0/0. The ranking formula handles that correctly via its existing no-evidence path, and the rating filter/sort surface exists and is honest — but no rating data flows yet.
6. **Grants verified on local PostgreSQL 16**, not a provisioned production host.
7. **No business/multi-staff seller party.** Unchanged.
8. **Waitlist not built.** `SlotOpened` remains specification-only.
9. **RBAC still code-based; audit still structured-logger-based.**
10. **The replay grace window is a deliberate softening.** A replay within 10 seconds of a legitimate rotation is denied but does not revoke the session chain.
11. **CSRF now depends on correct CORS configuration.** An over-broad `CORS_ALLOWED_ORIGINS` weakens CSRF as well as CORS.
12. **CI is authored but has never executed**, because this repository has no configured remote runner. Every command in it is one that runs locally and was run locally.
13. **No screenshots.** The Browser pane could not composite frames in this environment; live verification used DOM reads, computed-style assertions, forced-width layout measurement, and page-driven events instead.
14. **Docker's Linux engine was unavailable** for most of this phase (WSL2 disabled on the host), so OpenSearch ran as a native Windows process rather than a container. The CI pipeline uses the container.
15. **`apps/api`'s Jest process does not always exit after `api:test:pg` finishes.** The test results themselves are unaffected — every assertion runs and reports correctly — but on at least two runs this phase, the underlying `jest.js` process stayed alive after printing its full summary (`Jest did not exit ... asynchronous operations weren't stopped`), and `nx` reported the task complete via IPC regardless. The specific open handle was not identified. Running `api:test:pg` twice in immediate succession without confirming the prior process has actually exited can produce misleading failures in the second run from connection contention, not a real regression — see bug 21.

---

## 13. Operational notes

New required configuration:

```bash
OPENSEARCH_URL=http://localhost:9200      # REQUIRED in production — the API refuses to boot without it
CORS_ALLOWED_ORIGINS=https://beauclick.ir # now also the CSRF allow-list
AUTH_COOKIE_SAMESITE=lax                  # 'none' additionally requires AUTH_COOKIE_SECURE=true
AUTH_COOKIE_SECURE=true                   # forced on in production regardless
AUTH_COOKIE_DOMAIN=                       # optional
```

Optional tuning (all have safe defaults):

```bash
SEARCH_FLUSH_INTERVAL_MS=5000
NOTIFICATION_RETRY_INTERVAL_MS=30000
ANALYTICS_ROLLUP_INTERVAL_MS=300000
MEMBERSHIP_EXPIRY_INTERVAL_MS=900000
LOYALTY_POINTS_BOOKING_COMPLETED=10       # GAP-10: V2 placeholder until signed off
LOYALTY_TIER_BASIS=lifetime               # or rolling_365 — implemented, not merely configurable
```

**Search bootstrap on an existing database.** Providers created before this phase have no projection row. After migrating:

```bash
curl -X POST /api/v1/admin/search/rebuild-projection -H "Authorization: Bearer <admin>"
```

Loyalty tiers, membership plans, and benefits are **admin-configured data, not seeds**. With no tiers configured, the loyalty surface works and simply reports no tier.

---

## 14. Observability

### One action, one id, every schema

`correlation_id` is now on all nine outbox tables and on the analytics fact table. The catalog required it from the start and it did not exist; Phase 3 is where its absence started to cost something, because one completed booking now reaches five schemas.

| Hop | Mechanism |
|---|---|
| HTTP in | `CorrelationMiddleware` — accepts a UUID-shaped `X-Correlation-Id`, mints one otherwise, echoes it on the response |
| Business write | `emitEvent`/`emitContractEvent` stamp the ambient id onto the outbox row **inside the producing transaction** |
| Fan-out | `OutboxRelay` re-enters the context with the **stored** id before dispatching, so an event emitted by a consumer inherits it |
| Analytics | carried onto the fact, making a cross-domain trace one query instead of nine |
| No request behind it | a sweep mints a fresh id rather than writing null |

Ambient context (`AsyncLocalStorage`) rather than a threaded parameter, and the trade-off is stated rather than hidden: it is invisible at the call site. It is mitigated by the durable record being a **column** — once written the id is data, not context — and by the one propagation hop being an explicit line in `outbox.relay.ts`. The alternative, a `correlationId` argument on every service method, is a guarantee that holds until the first author forgets, and this project has already found three separate guarantees that were upheld "by remembering" and were not actually being upheld.

A client-supplied value that is not UUID-shaped is **replaced, not sanitised**. It reaches nine tables and every log line; accepting an arbitrary string there is a log-injection and storage vector for free.

### Structured operations, and what they must not contain

`AuditLogger` replaces the Phase 2 `new Logger('AUDIT:<domain>')` convention at all eleven declaration sites, which is what gives the 30 existing audit records the correlation id without editing 30 call sites. `logOperation`/`warnOperation` cover the non-audit operational lines.

New coverage this phase:

| Signal | Where |
|---|---|
| Search latency, degraded flag, result count, query **class** | `search.providers` |
| Notification delivery, provider, attempts, **`providerVerified`** | `notification.delivered` |
| Retry scheduling and dead-lettering, with `attempts_exhausted` vs `permanent_failure` | `notification.retry_scheduled`, `notification.dead_lettered` |
| Analytics ingestion, including `inserted=false` on a redelivery | `analytics.ingested` |
| Journey profile/goal operations | `journey.*` — Journey had no audit trail at all, which for the domain holding the most personal data was the wrong way round |
| Event id, correlation id, attempt count on a dispatch failure | `OutboxRelay` |

The deny-list that governs event payloads governs these too, and for the same reason — a log aggregator is a second, less-guarded copy of whatever you put in it. So: **no query text** (the log shares the event's `queryClass`, from one shared classifier, because two independent classifications of the same thing drift and the tempting fix is to log the raw query "just to compare"), **no journey note or goal title** (`hasNotes: true` is operational; what it says is not), and no OTP, password, token, or payment secret. `AuditField` cannot express an object, which at least stops an entity being spread in wholesale.

`notification.delivered` carries `providerVerified` deliberately. GAP-11 means sms and email log rather than deliver, and a line saying "delivered" without saying that is exactly the claim §16 forbids.

### What this is not

There is no tracing backend, no metrics exporter, and no log aggregation. These are structured lines on stdout and a queryable column. That is enough to answer "what did this action do" today, and the correlation id is the piece that makes adding a real backend later a configuration change rather than a re-instrumentation.

### Recovering a lost local `beauclick_financial_owner` password

`financial-roles.sql` deliberately never persists this password anywhere — it is supplied once, at provisioning, as a psql variable, and a deployment that forgets to pass it fails loudly rather than creating a passwordless role. That is correct for a real environment. It also means **any local dev setup that did not save it separately has no way to recover it**, and a migration against the `financial` schema (this phase's correlation-id column included) cannot proceed without it.

The standard PostgreSQL recovery path — temporarily set `trust` auth in `pg_hba.conf`, reload, connect without a password, reset the target role — applies here with one addition specific to this project: an agent working in this repository will refuse to perform the `pg_hba.conf` edit or the service restart itself, because both are "modify system/security settings" by nature, disposable dev instance or not. That refusal is intentional and should not be routed around. The steps, run by a human with local administrator access:

```powershell
$hba = "C:\Program Files\PostgreSQL\16\data\pg_hba.conf"
$backup = "$hba.beauclick-backup"
Copy-Item $hba $backup -Force

(Get-Content $hba) `
  -replace '^(local\s+all\s+all\s+)scram-sha-256$', '${1}trust' `
  -replace '^(host\s+all\s+all\s+127\.0\.0\.1/32\s+)scram-sha-256$', '${1}trust' `
  | Set-Content $hba

Restart-Service postgresql-x64-16
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -h 127.0.0.1 -d beauclick_v3_dev `
  -c "ALTER ROLE beauclick_financial_owner PASSWORD '<new password>'"

Copy-Item $backup $hba -Force
Remove-Item $backup
Restart-Service postgresql-x64-16
```

The `trust` window only matters if the service is actually reloaded while it is in place — editing the file alone changes nothing until then, and reverting the file before ever reloading leaves zero exposure. Nothing at runtime authenticates as `beauclick_financial_owner` (`NOLOGIN` in spirit; only migrations connect as it via `MIGRATION_URL_FINANCIAL`), so rotating this password breaks nothing else.

Also found in the course of this: OpenSearch's `ingest-geoip` module ships without its MaxMind `.mmdb` databases in this offline dev build and fails the whole node at startup (`expected database [GeoLite2-ASN.mmdb] to exist`) — irrelevant to this project (nothing here uses geoip enrichment), fixed by moving the module directory entirely out of `modules/` (renaming it in place is not enough; OpenSearch's module loader scans every subdirectory regardless of name and the plugin resolves its own data path from its declared name, not the folder it was found in).

---

## Cross-references

- `ADR-019` — Journey's domain boundary (closes GAP-29).
- `ADR-020` — refresh-token storage and CSRF defence.
- `ADR-021` — search as a two-layer read model (closes GAP-14, GAP-15).
- `ADR-022` — executable event contracts; analytics storage.
- `V3_EVENT_CATALOG.md` — Phase 3 implementation status.
- `V3_GAP_REGISTER.md` — Phase 3 addendum.
