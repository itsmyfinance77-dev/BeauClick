# ADR-036: Referral Attribution — The Authenticated Claim, Database-Enforced Once-Ever, and the Indistinguishable Refusal

**Status:** Accepted — implemented in V3.2-C Story #27 (attribution claim lifecycle).
**Date:** 2026-08-31.
**Relates to:** ADR-035 (the referral domain, code identity, and the share boundary — this ADR continues it and revisits none of it), ADR-011 (composition-root boundary: a domain declares a port, `apps/api` binds it), ADR-027 (subject-data contract and boot-time coverage), ADR-024 (waitlist concurrency — the conditional-write discipline this ADR reuses twice), ADR-017 (why a guarantee that matters is enforced by the database rather than by policy), `V3_SECURITY_MODEL.md` §3 (indistinguishable refusals, no caller-supplied identity), `V3_DATABASE_BLUEPRINT.md` §§1–4.
**Binding on:** `V32-DEC-019` (database constraints, the claim throttle, the immutability requirement, the indistinguishable refusal, and the ratified subject-data dispositions and export shapes), `V32-DEC-017` (the 90-day pending expiry), `V32-DEC-018` (the qualifying event, which this story deliberately does not consume), `V32-DEC-033` (the code is a bearer credential and never leaves the authenticated read route), `V32-DEC-034` (the ratified code format).
**Does not decide:** qualification, reward values, reward issuance, reversal, clawback, the abuse suite, or any frontend. Those are Stories #12, #28, #13, and #14, and §12 states the boundary precisely so this ADR is not read as having settled them.

## Context

Story #11 shipped a referral **code**: a bearer credential, one per owner, drawn from a CSPRNG, that leaves the platform only through its owner's authenticated read route. It attributed nothing to anybody. This ADR covers the story that turns a held code into a **relationship** — and the relationship is the first object in the referral domain that is about *two* people, which is what makes every question below harder than its Story #11 equivalent.

Five facts about the repository and the closed decisions shaped this ADR.

**There is no signup route and no new-account signal.** `POST /v1/auth/verify-otp` is `@Public()` and is simultaneously login and registration; `AccountResolverService.resolveOrCreate(phone)` creates the row, and `LoginResult` carries no `isNewUser` flag. A referral code therefore cannot be attached "at signup" without widening a public unauthenticated route to accept a bearer credential — which is why Issue #11 was split rather than re-pointed, and why the claim is a separate authenticated route rather than a parameter on an existing one.

**The owner already closed every rule this story enforces.** `V32-DEC-019` is unusually complete: it names the constraints (*self-referral unrepresentable*, *attributed once ever*), the throttle (*10 attempts per authenticated caller per hour, in PostgreSQL, never the in-memory HTTP throttler*), the immutability requirement (*no route, service method, or admin path rewrites the referrer, the code, or the attribution instant*), the collapsed refusal, the subject-data disposition for `referral.referrals`, and the export shapes for both sides. `V32-DEC-017` fixes the pending expiry at 90 days. This ADR implements those literally; where it adds anything, §11 says so and says why.

**The claim route is the first place in the referral domain where a code is looked up by value.** Story #11's controller has no refusal to make indistinguishable, and ADR-035 §10 records why: no route there can address another party's code, so the question cannot be asked. Here it can be asked, by anybody, ten times an hour. Everything in §6 follows from that.

**The refusal cases are not symmetric in what they would reveal.** "Unknown code" leaks the keyspace. "That is your own code" confirms the caller guessed their own string, which is harmless — but a *distinct* answer for it tells an attacker that a differently-shaped answer means somebody else's code exists. "Already attributed", "account too old", and "already booked" are facts about the **caller**, which the caller mostly knows. Collapsing all six is therefore not about hiding things from the caller; it is about ensuring that the response cannot be used as a **lookup function over other people's codes**. §6 states this as the property to test rather than as a rule to remember.

**A retained two-party row is a new privacy shape for this domain.** Story #11's table was single-party and hard-deleted. `referral.referrals` is `retained` — because it is what explains a loyalty entry the *other* party still holds — and retention plus two subjects is exactly the combination where an erasure quietly leaves somebody's data behind. §9 implements the owner's ratified disposition and §10 states what the tests must prove rather than assert.

## Decision

### 1. One route, authenticated, and the referee is never an input

```
POST /api/v1/me/referral/claim
```

Mounted under `v1/me/referral`, alongside Story #11's `GET code`, for the reason ADR-035 §10 records: there is no path segment that could be mistaken for a subject id. The referee is `@CurrentUser().userId` from the verified JWT and comes from nowhere else.

**The request body has exactly one field.**

```ts
{ code: string }
```

`code` is the **only client-controlled claim credential in the story**. The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so any other property — `refereeUserId`, `referrerUserId`, `ownerUserId`, `userId`, `phone`, `createdAt`, `accountAge`, `hasCompletedBooking`, `rewardAmount`, `expiresAt`, `status` — is **refused with a 400**, not ignored.

That distinction is load-bearing and is the same one Story #11 made for its empty query DTO. A silently-ignored `refereeUserId` is a field somebody later wires up by accident, and until they do it trains callers to believe the server read it. A 400 says the field does not exist, which is true. It is also why the DTO is a **closed class with one property** rather than `Record<string, unknown>`.

**No capability is created.** The route acts on the caller's own attribution and gates no privileged action — the same reasoning ADR-035 §10 records for the read route, and the same reasoning `journey`, the customer half of `loyalty`, and `wishlist` all record. There is consequently no `@AuditAction` and no `AuditModule` import: `libs/audit`'s boot check requires one only for a mutation gated by a **privileged** capability.

### 2. `referral.referrals` — the constraints are the design

```
referral.referrals
  id                 UUID PRIMARY KEY
  referrer_user_id   UUID NOT NULL
  referee_user_id    UUID NOT NULL  UNIQUE     -- attributed once, EVER
  referral_code_id   UUID NOT NULL             -- which code was claimed; NOT the code string
  attributed_at      TIMESTAMPTZ NOT NULL
  expires_at         TIMESTAMPTZ NOT NULL      -- attributed_at + 90 days
  referrer_erased_at TIMESTAMPTZ NULL          -- tombstone marker, §9
  referee_erased_at  TIMESTAMPTZ NULL          -- tombstone marker, §9

  CONSTRAINT uq_referrals_referee        UNIQUE (referee_user_id)
  CONSTRAINT ck_referrals_no_self        CHECK  (referrer_user_id <> referee_user_id)
  CONSTRAINT ck_referrals_expiry_after   CHECK  (expires_at > attributed_at)
```

**`UNIQUE (referee_user_id)` is the once-ever guarantee, and it is the only one.** There is no application check that "really" enforces it and no advisory lock in front of it. Two concurrent claims for one referee both pass every eligibility read — under `READ COMMITTED` neither transaction can see the other's uncommitted row — and this constraint is what decides which one wins. The loser catches `23505` on this constraint name and returns the collapsed refusal. That is the same shape `uq_referral_codes_owner` already has in Story #11 and the same shape `V32-DEC-019` demands in the same words for the referrer cap: *never a read-then-write*.

**`CHECK (referrer_user_id <> referee_user_id)` makes self-referral unrepresentable**, which is stronger than preventing it. The service also refuses it earlier, with the collapsed refusal, so a caller claiming their own code gets the same answer as every other refusal rather than a constraint error — but the *guarantee* is the CHECK, and the suite proves it by attempting a **raw INSERT** that bypasses the service entirely.

**`referral_code_id`, not the code string, and this is a privacy decision rather than a normalisation preference.** Storing the claimed code on this row would retain a **bearer credential belonging to the referrer** on a row that is `retained` past the referrer's erasure — and would put it one careless join away from the referee's export, which `V32-DEC-019` forbids in terms: *a referee's export contains their own referral fact and never the referrer's bearer code*. An opaque internal UUID is not a credential and cannot be typed into a claim.

**There is no foreign key to `referral.referral_codes`, and the absence is deliberate rather than conventional.** The two rows have deliberately different erasure lifecycles: the code is **deleted** on its owner's erasure (`V32-DEC-019`, ADR-035 §6) while this row is **retained**. No referential action expresses that — `CASCADE` would destroy the retained relationship, `RESTRICT` would make erasure impossible, and `SET NULL` would mutate a frozen column. A dangling `referral_code_id` after the referrer's erasure is therefore the **correct** end state: the credential is destroyed and the relationship survives, which is exactly the disposition the owner ratified.

**No `status`, no `qualified_at`, no `reward_*`, no `capped`, no `reversal_*`, no `review_*` column.** `V32-DEC-019` permits a capped-or-refused enum *on the referral row*, and `V32-DEC-016`/`V32-DEC-017` define qualification and reversal — all of which belong to Stories #12 and #28. A column those stories will fill, added now, would need a subject-data claim nobody can verify and a meaning nothing enforces. The pending state in this story is **the existence of the row plus `expires_at`**, and that is complete: an attribution that never qualified and whose `expires_at` has passed is expired, and the thing that reads it does not exist yet.

**Identity-bearing columns carry the `_user_id` suffix** — `referrer_user_id`, `referee_user_id` — because ADR-027's boot-time coverage heuristic recognises that suffix and would reject a `no_subject_data` claim on this table on the strength of the column name alone. The declared disposition and its test are the real guarantee; the naming is belt, not braces. It is also why the throttle table's column is `claimant_user_id` rather than `user_id`.

### 3. Immutability is enforced by the database, not by the absence of a route

`V32-DEC-019`: *no route, service method, or admin path rewrites the referrer, the code, or the attribution instant.* Story #27 requires a second attribution to be **unwritable**, not merely unimplemented.

`UNIQUE (referee_user_id)` already makes a second *insert* unwritable. It says nothing about an `UPDATE`, and "there is no route that does that" is exactly the guarantee that decays the first time somebody adds an admin surface.

**So a `BEFORE UPDATE` trigger raises on any change to the four frozen columns:** `referrer_user_id`, `referee_user_id`, `referral_code_id`, `attributed_at`.

```sql
CREATE FUNCTION referral.reject_attribution_rewrite() RETURNS TRIGGER ...
  IF NEW.referrer_user_id IS DISTINCT FROM OLD.referrer_user_id
     OR NEW.referee_user_id  IS DISTINCT FROM OLD.referee_user_id
     OR NEW.referral_code_id IS DISTINCT FROM OLD.referral_code_id
     OR NEW.attributed_at    IS DISTINCT FROM OLD.attributed_at
  THEN RAISE EXCEPTION ...
```

**This is the first trigger in the repository, and that deserves a justification rather than a shrug.** The platform's existing immutability mechanism is privilege revocation: `financial.ledger_entries` is owned by `beauclick_financial_owner` and `REVOKE UPDATE` strips the application role (ADR-017). That mechanism is unavailable here for a specific reason — `referral` is an **application-owned** schema, and §9's tombstone requires the application role to update `referrer_erased_at` / `referee_erased_at` on this very table. A blanket `REVOKE UPDATE` would break erasure; a column-level grant would still leave the owner able to re-grant itself in one statement, which is precisely the argument ADR-017 makes *against* an application-owned ledger.

A trigger fires for the table owner too, and it protects the four columns while leaving the two tombstone columns writable. It is the only mechanism that expresses "these four are frozen and those two are not". `expires_at` is deliberately **outside** the frozen set even though nothing updates it: freezing it would be freezing a column whose Story #12 semantics are not yet decided, and the four columns the decision names are the four the decision names.

The trigger is proved by the suite attempting the rewrite through raw SQL, not by the absence of a service method — and the non-vacuity pass drops the trigger and requires that test to fail.

### 4. Eligibility, and the two ports that answer it authoritatively

A claim is accepted only if **all** of the following hold. The order below is the evaluation order, and it is not observable: every failure produces one byte-identical refusal (§6).

| # | Condition | Source of truth |
|---|---|---|
| 1 | The code exists and is currently claimable | `referral.referral_codes`, by `code` |
| 2 | The code's owner is not the caller | the same row |
| 3 | The caller has never been attributed | `referral.referrals`, by `referee_user_id` |
| 4 | The caller's account age is **≤ 30 days** | `ReferralIdentityPort` over `identity.users.created_at` |
| 5 | The caller has **no completed booking** | `ReferralBookingPort` over `booking.bookings` |
| 6 | The caller is within the claim throttle | `referral.claim_attempts` (§5) |

**Condition 1 has no "revoked" branch, and Story #27's mention of a revoked code resolves to this.** ADR-035 §2 and the Story #11 migration deliberately give `referral_codes` no `revoked_at`: erasure is a hard `DELETE`, and a soft-revocation column would make that claim false in the schema while it was true in the code. A revoked code is therefore an **absent row**, indistinguishable from a code that never existed — by construction rather than by a collapsing branch. This story adds no such column: doing so would be both a speculative column and a reversal of a closed decision.

**The throttle is charged first in execution order** even though it is listed last, because it must count an attempt that goes on to fail (§5).

#### `ReferralIdentityPort` and `ReferralBookingPort`

Both are declared by `referral`, implemented in `apps/api/src/composition`, and bound there — the ADR-011 shape `WISHLIST_TARGET_PORT` established and that lint enforces: an `@beauclick/identity` or `@beauclick/booking` import inside `services/referral` fails CI.

```ts
interface ReferralIdentityPort {
  accountCreatedAt(manager: EntityManager, userId: string): Promise<Date | null>;
}
interface ReferralBookingPort {
  hasCompletedBooking(manager: EntityManager, userId: string): Promise<boolean>;
}
```

**Both take the caller's `EntityManager` and both run inside the claim's transaction.** This is not a style preference. A port that opens its own connection inside a caller's transaction is the defect V3.2-B recorded as bug #2, where N concurrent senders needed 2N connections against a pool of 10 and the suite *stopped* rather than failing. It is also a correctness requirement here: an eligibility fact read outside the transaction that inserts the row is a fact that can change between the read and the write.

**Both read the authoritative tables and nothing else.** Not the search projection, not a cache, not an analytics rollup, not a denormalised browser payload, and not anything the caller sent. `PublicCatalogueAiAdapter` and `WishlistTargetAdapter` both record the reasoning and it transfers unchanged: a projection is eventually consistent, so it can still assert a fact the platform has just changed. Discovery is fast and eventually consistent; an eligibility gate is slow and strictly consistent, and that is the correct way round.

**`accountCreatedAt` returns a `Date` and lets the domain decide**, rather than returning a boolean the adapter computed. The 30-day rule is a product decision (`V32-DEC-019`'s claim window, Issue #27's acceptance criterion); putting the comparison in `apps/api` would put a decision in the composition root and make the boundary the thing that owns it. A `null` return — no such user — is treated as ineligible.

**`hasCompletedBooking` returns a boolean and does *not* return the booking**, because the domain has no legitimate use for a booking id, a professional id, or a date, and a record returned is a record that ends up somewhere. It reads `booking.bookings` where `customer_id = $1 AND status = 'completed'` with `LIMIT 1`, which the existing `ix_bookings_customer_status` index serves. `completed` is the single terminal status the booking state machine uses for a fulfilled appointment; `confirmed`, `pending`, `cancelled`, `expired`, and `no_show` are all *not* completed, and `V32-DEC-018` makes the same distinction from the other direction when it rules that `BookingConfirmed` never qualifies.

### 5. The 30-day boundary and the 90-day expiry, from an injected clock

`ReferralClock` is injected exactly as `ChatClock` is, and nothing in this module calls `new Date()` or `Date.now()` outside it. A rule that reads the wall clock can only be tested by waiting or by fabricating timestamps and hoping the fabrication matches production — and a boundary condition is precisely what is left unproved that way.

**Account age — inclusive at exactly 30 days.** Issue #27 says *account age ≤ 30 days*, so the boundary is inclusive and the comparison is:

```
now - created_at <= 30 days      → eligible
now - created_at >  30 days      → refused
```

expressed as an absolute UTC duration: `created_at >= now - 30×86_400_000 ms`. An account created **exactly** 30 days ago to the millisecond is **eligible**. Both sides of that millisecond are tested with a frozen clock.

**Expiry — `attributed_at + 90 days`, absolute UTC.** `V32-DEC-017` fixes the pending expiry at 90 days. It is computed as `new Date(attributedAt.getTime() + 90×86_400_000)` — an absolute duration, deliberately **not** a Tehran calendar boundary and deliberately not `setUTCMonth`.

The distinction is the one `ChatClock`'s docblock already draws and it matters here for the same reason: `ai`'s quota is *twenty messages per Tehran calendar day*, a promise about a person's calendar, so it needs a calendar. This is a duration between two instants. A calendar boundary would introduce a DST-free but month-length-dependent discontinuity and would make "90 days" mean something subtly different for a claim at 23:00 than for one at 01:00. `V32-DEC-019`'s referrer cap **is** per *Tehran calendar month* and that is Story #12's problem, not this one; the two must not be confused, and this ADR names the difference so they are not.

`attributed_at` is set from the injected clock, not from `now()` in SQL, so the row's two timestamps are computed from one instant and the 90-day relationship is exact rather than approximately exact. `ck_referrals_expiry_after` is a floor, not the mechanism.

### 6. The claim throttle: 10 per caller per hour, in PostgreSQL

```
referral.claim_attempts
  claimant_user_id  UUID NOT NULL
  window_start      TIMESTAMPTZ NOT NULL   -- start of the UTC hour
  attempt_count     INT NOT NULL
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  PRIMARY KEY (claimant_user_id, window_start)
```

Charged by one conditional statement, which is the whole algorithm:

```sql
INSERT INTO referral.claim_attempts (claimant_user_id, window_start, attempt_count)
VALUES ($1, $2, 1)
ON CONFLICT (claimant_user_id, window_start) DO UPDATE
  SET attempt_count = referral.claim_attempts.attempt_count + 1, updated_at = now()
  WHERE referral.claim_attempts.attempt_count < $3
RETURNING attempt_count
```

Zero rows returned means the limit is spent. This is the `chat.send_counters` and `ai.usage_daily` shape, and `V32-DEC-019` forbids the alternative in the same words it uses for the referrer cap: *a single conditional `INSERT … ON CONFLICT DO UPDATE … WHERE count < limit RETURNING`, never a read-then-write*. A read-then-write lets two concurrent claims both observe 9 and both write 10, which is `GAP-04` reproduced knowingly.

**Not the in-memory HTTP throttler.** `BeauClickThrottlerGuard`'s storage is per-process, so its effective limit multiplies by instance count while `THROTTLE-STORE` is unresolved. The guard still runs as coarse abuse control; it is not what makes ten mean ten. A PostgreSQL row is shared across every instance by construction.

**Hour buckets rather than a rolling window**, for the contention reason `minuteBucket` records: one counter row per user, rewritten on every attempt, is the hottest row in the schema and serialises every claimant against every other. Bucketing means the conditional increment only serialises claimants inside the same hour — which is exactly the set the limit is about.

#### The three semantics the decisions do not spell out letter-by-letter

`V32-DEC-019` and Issue #27 both say "10 attempts per authenticated caller per hour" and stop. Three questions follow, and each has **one answer already implied by the repository and by the decisions' own reasoning**, so they are resolved here rather than referred back:

**(a) Which requests consume an attempt? Every request that reaches the check, including ones that then fail.** `V32-DEC-034` prices this number as a **guess rate** — its brute-force table reads *"10 per hour — the Story #27 throttle → exhaustive search ≈ 9.35 billion years"*, and it is the stated reason the code is ten characters rather than eight. A throttle that counted only *successful* claims would bound nothing, would make that table false, and would leave the code length justified by a control that does not do what the justification says. So the slot is reserved **before** eligibility is evaluated. `reserveSendSlot`'s docblock already states the identical principle for chat: *a caller who trips the cap has already been counted … because the request was accepted for rate-limiting purposes even though it is refused.*

**(b) What does a successful claim do to the counter? It consumes one attempt, like every other request, and nothing else.** There is no reset, no refund, and no special case. A successful claim is terminal for that caller anyway — `UNIQUE (referee_user_id)` means every later claim they make refuses — so a reset would have no observable effect except to complicate the one statement that has to be atomic. Refunding the attempt on success would also, unhelpfully, make the counter a signal about outcomes rather than about attempts.

**(c) What is returned once the limit is spent? `429`, and it is deliberately *not* folded into the indistinguishable refusal.** `V32-DEC-019` enumerates exactly six cases to collapse — unknown code, revoked code, the caller's own code, already attributed, account too old, already booked — and Issue #27's acceptance criteria repeat the same six. Throttle exhaustion is in neither list. It is also categorically different from all six: those are facts about **other people's codes and the caller's own eligibility**, and a distinct answer to any of them turns the route into a lookup function. Exhaustion is a fact about **how many requests the caller just made**, which the caller already knows, and which reveals nothing about any code, any account, any booking, or any owner. Returning `429` therefore adds no oracle, and it is the platform's existing answer for a spent limit (`RateLimitedException`, `ChatRateLimitedException`).

The stronger reading is also the wrong one: collapsing exhaustion into the standard refusal would tell an attacker who had spent their ten guesses that all ten were *wrong*, since a refusal is what a wrong guess returns — an actively worse outcome than a 429 that says nothing about the guesses at all.

### 7. The transaction boundary

One transaction per claim, opened by the service, containing **in this order**:

1. the throttle reservation (§6) — first, so a refused claim still counts;
2. the code lookup, and the self-referral check;
3. the prior-attribution check;
4. `ReferralIdentityPort.accountCreatedAt` on the same `EntityManager`;
5. `ReferralBookingPort.hasCompletedBooking` on the same `EntityManager`;
6. the `INSERT`, whose unique violation is caught and collapsed.

Every read that gates the write happens inside the transaction that performs it, on the caller's manager. A refusal after step 1 **commits the throttle increment** rather than rolling it back — which is the point of charging first, and is why the reservation and the refusal cannot share a rollback boundary. Concretely: the throttle is charged in its own committed statement path, and an eligibility refusal is raised as a domain exception after that charge is durable.

### 8. One refusal, byte-identical

Every one of the six enumerated eligibility failures produces exactly this, with the same status, the same code, the same message, and the same absence of `details`:

```
409 Conflict
{ "code": "REFERRAL_CLAIM_REFUSED", "message": "<one fixed Persian sentence>" }
```

**The property, stated as the thing to test:** the route must not be usable as a **code oracle**, an **account-existence oracle**, a **booking-history oracle**, or a **code-owner oracle**. It carries no `reason`, no discriminator, no `retryAfter`, no referrer identity, no phone, no user id, no internal cause, and no field that differs between the six cases — because there is exactly one exception class and it takes no arguments.

The suite compares **complete response bodies**, not status codes, across all six cases and requires them to be `toEqual`. A status-code-only assertion would pass while a `details.reason` leaked the branch, which is the failure this is written to catch.

There is deliberately **no closed refusal vocabulary in the contract for this route**, unlike `ChatRefusalReason`. Chat has one because a chat refusal is *meant* to be actionable — a blocked conversation and a closed send window need different UI. Here a vocabulary would be a set of names for distinctions the response is forbidden to make; exporting one would invite a client to switch on a value the server must never send.

`429` (§6c) and `400` (a forged field, §1) are outside this set and are supposed to be: neither is an eligibility answer.

### 9. Privacy: retained, with the erased side tombstoned

`V32-DEC-019` ratifies the disposition directly, and the reason with it: **`referral.referrals` is `retained`, with the erased side's identity tombstoned, because the row is what explains a retained loyalty ledger entry the other party still holds.** Destroying it would leave a points row with no explanation.

`referral.claim_attempts` is `subject_data`, **deleted** on erasure — *a rate-limit counter about a person who no longer exists*, which is the treatment `V32-DEC-019` prescribes for `referral.referrer_counters` and the treatment `chat.send_counters` already receives, in the decision's own words.

**The tombstone reuses the platform mechanism and invents nothing.** `tombstoneFor(userId, erasedAt)` already produces the deterministic placeholder every module shares; `eraseSubjectData` already receives it. This module stamps the erased side's marker column with `tombstone.erasedAt`:

- the **referrer** erases → `referrer_erased_at` is stamped, and their `referral_codes` row is deleted by Story #11's existing contract, so the credential is gone and the relationship survives for the referee's retained loyalty entry;
- the **referee** erases → `referee_erased_at` is stamped, and the row survives for the referrer's retained entry;
- **both** erase → both markers are stamped and the row still holds nothing but opaque ids and instants.

The row never held a name, a phone, a display value, or free text — only ids — so there is no identifying content to destroy, which is the platform's stated erasure model for id-only rows. What the marker adds is the thing the decision asks for and the ids alone do not provide: a **positive record that this side is erased**, so no surface can present the relationship as involving an active account, and so the erasure report can count it honestly as `anonymized` rather than silently as nothing.

**No active account access is preserved for an erased subject**: identity's own erasure destroys the phone, the display name, and the sessions, and this row grants no access to anything.

**Export shapes, bound by `V32-DEC-019`.**

- A **referrer's** export contains their own referral facts and **no referee identity** — so the section carries `attributedAt` and `expiresAt` and **not** `referee_user_id`. A count is not exported either: it would be a fact about how many people the referrer recruited, derived from rows about other subjects.
- A **referee's** export contains their own referral fact and **never the referrer's bearer code** — which is structural rather than filtered, since §2 keeps the code string off this table entirely. It carries `attributedAt` and `expiresAt` and not `referrer_user_id`.
- **No internal eligibility reason appears in any export**, because none is stored: there is no column that could hold "refused because the account was too old".

### 10. No event, no outbox, no notification, no analytics, no metric, no log

**`ReferralAttributed` is not defined and is not emitted.** `V32-DEC-033` and ADR-035 §7 already record the reason and it has not changed: **it has no consumer.** Story #12 consumes `BookingCompleted` (`V32-DEC-018`), not an attribution event; nothing notifies on attribution, because `V32-DEC-033` restricts referral notifications to the *qualified* and *reversed* moments. Defining it would ship a contract nothing publishes and nothing reads, and the outbox table it would need would itself require a subject-data claim nobody could verify.

There is consequently **no `referral.outbox_events` table** in this story either.

**The code never appears in an event, an outbox payload, a notification, an analytics dimension, a metric label, a structured log, an exception message, an audit reason, or a trace.** As in ADR-035 §8, this is enforced by there being no path rather than by redaction: no event is emitted, no metric is registered, no notification is sent, the refusal exception takes no arguments, and the one operational log line records ids and an outcome enum with the code passed as no argument to anything.

**The tests for this are required to be non-vacuous.** An absence assertion that passes because the capture mechanism caught nothing is worse than no assertion, and this suite already learned that once — `recordLogging`'s docblock records a version that captured only the process streams and passed while capturing **nothing**. So the log-leak detector is proved to work by **planting a forbidden value** through the same capture path and requiring the detector to find it, before the real assertion is trusted.

### 11. What this ADR adds beyond the closed decisions, stated plainly

Three things below are engineering realisations rather than owner decisions, and each is recorded here so a reader can tell them apart from the ratified rules above:

- **The `BEFORE UPDATE` trigger (§3).** `V32-DEC-019` requires immutability and does not name a mechanism. The trigger is the only mechanism available in an application-owned schema that also permits §9's tombstone. It is the repository's first, and §3 justifies the departure.
- **`referral.claim_attempts` as a table name and shape (§6).** The owner ratified the *limit* and the *enforcement layer*, and ratified the disposition for the analogous `referral.referrer_counters`. The table's name, its hour bucket, and its column list are engineering.
- **The three throttle semantics in §6(a)–(c).** Each is resolved from the decisions' own reasoning — the guess-rate framing in `V32-DEC-034` and the six-case enumeration in `V32-DEC-019` — rather than chosen. They are written down because a future reader will otherwise assume they were arbitrary.

Anything a future decision wants to change in this list is a decision-register entry, not a refactor.

### 12. What this story is NOT

**No qualification and no reward.** No `BookingCompleted` consumer, no `referral.reward_grants`, no `referral.referrer_counters`, no monthly cap, no loyalty movement, no point value, no `ReferralQualified`. Story #12. `V32-DEC-016` sets both reward values to 0 and this story writes no ledger row of any kind.

**No reversal and no clawback.** No refund listener, no `ReferralReversed`, no reversal state. Story #28.

**No abuse suite beyond this story's own adversarial tests.** Story #13.

**No manual review, no appeal, no administrator override.** `V32-DEC-019` refuses all three outright; there is no route and no column.

**No device, IP, browser, or fingerprint signal.** `V32-DEC-019` refuses (c) explicitly. Nothing here reads `request_ip`, `user_agent`, or `device_label`, and no column could hold one.

**No frontend and no design artifact.** Story #14.

## Consequences

- An invited account can be attributed to a referrer exactly once, ever, and the guarantee is a unique index rather than a code path.
- Self-referral is unrepresentable, provably including through raw SQL.
- An attribution cannot be rewritten by any path, including a future administrative one nobody has written yet, because the database refuses it rather than because no such route exists.
- The claim route is not a code, account, booking, or owner oracle, and the assertion is over complete response bodies rather than status codes.
- Guessing is bounded at 10 attempts per caller per hour across every API instance, which is the rate `V32-DEC-034` priced the code length against — so the ten-character justification is now backed by the control it named.
- The referral domain gains two ports over `identity` and `booking`, both narrow, both read-only, both transactional, and both bound in the one module permitted to know about all three domains.
- A retained two-party row exists for the first time in this domain, with both sides' erasure paths implemented and tested rather than deferred.
- Stories #12 and #28 inherit a table, an immutable relationship, and a pending expiry. They add qualification, reward, and reversal; they do not revisit attribution.

## What is deliberately not decided here

- **Qualification, reward values, and the referrer's monthly cap** — Story #12, now decided in **ADR-037**, which continues this ADR and revisits none of it. **Reversal and clawback** remain undecided here — Story #28, under `V32-DEC-017`.
- **What reads `expires_at`.** This story computes and stores it correctly; the story that acts on an expired pending attribution is #12, which has since done so — its compare-and-swap reads `expires_at > now` with a **strict** comparison (ADR-037 §2), so a pending attribution lapses at the instant it lapses.
- **Any revocation state that is not erasure** — unchanged from ADR-035: a migration and a decision if it is ever wanted, not a nullable column added on the chance somebody does.
- **The erase-then-re-register gap.** `V32-DEC-019` records it knowingly: erasure rewrites `users.phone` to a tombstone alias, so the number becomes registrable again after the 7-day grace window, producing a genuinely new `user_id` with a genuinely new `created_at` that nothing detects. The monthly referrer cap is the bounded-exposure control. This story does not close it and does not claim to.
