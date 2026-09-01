# ADR-037: Referral Qualification — The Compare-and-Swap, Two Independent Reward Sides, and the Honest Zero

**Status:** Accepted — implemented in V3.2-C Story #12 (qualification and independent two-sided loyalty reward).
**Date:** 2026-09-01.
**Relates to:** ADR-036 (the attribution claim lifecycle this continues and revisits none of), ADR-035 (referral code identity and the share boundary), ADR-011 (composition-root boundary), ADR-022 (event contracts and the transactional outbox), ADR-027 (subject-data contract and boot-time coverage), ADR-024 (waitlist concurrency — the conditional-write discipline this reuses a third time), ADR-017 (why a guarantee that matters is enforced by the database), `V3_SECURITY_MODEL.md` §3, `V3_DATABASE_BLUEPRINT.md` §§1–4.
**Binding on:** `V32-DEC-016` (two sides, two ledger reasons, two independent values, both **0**, and zero means honestly disabled), `V32-DEC-018` (the qualifying event and the three explicit non-triggers), `V32-DEC-019` (the per-referrer monthly cap, the independence of the two sides at the cap, and compare-and-swap replay safety), `V32-DEC-017` (the 90-day pending expiry this story consumes but does not re-decide), `V32-DEC-033` (the approved event vocabulary, the payload prohibitions, and the in-app opt-outable notification boundary).
**Does not decide:** reversal, clawback, negative ledger rows, the refund consumer, or any order-lookup port. Those are Story #28, and §13 states the boundary precisely so this ADR is not read as having settled them.

## Context

Story #27 gave the platform an **attribution**: a pending, immutable, once-ever relationship between two people, carrying an expiry and nothing else. Nothing read it. This is the story that gives it consequences — and the consequences cross a ledger, which is what makes it different in kind from everything the referral domain has done so far.

Six facts about the repository and the closed decisions shaped this ADR.

**Three of the things this story needs already exist and are already correct.** `LoyaltyLedgerService.award(input, manager)` already takes a caller's `EntityManager`. It already returns early on a zero configured value **without inserting a row and without consuming the idempotency slot** — with a docblock naming `pointsReferralQualified` as the reason it was written that way. And `libs/events/src/sql-result.ts` already carries `returningRows` / `affectedAny`, written after the `[rows, rowCount]` shape caused **two separately-diagnosed bugs** (a revision that never advanced, and a revoked refresh token that successfully minted a session). Story #12 does not get to rediscover any of these; it gets to use them.

**`BookingCompleted` v1 is already sufficient, so no lookup port is needed.** It carries `bookingId`, `professionalId`, `customerId`, `serviceId`, `completedAt`. `customerId` **is** the referee, and `bookingId` **is** the qualifying booking. §4 therefore declares no port over `booking` at all, and the absence is a finding rather than an omission: the alternative — a composition-root lookup — would have been a seam nothing crossed.

**The ledger's `reason` column has no CHECK constraint.** `reason VARCHAR(64) NOT NULL`, with the idempotency guarantee carried by `uq_points_entries_reference_once (reference_type, reference_id, reason) WHERE reference_type IS NOT NULL`. So two new reasons cost **no loyalty migration**, and §9 records what that means for the role boundary.

**A single `referral_qualified` reason exists today, and it is the exact shape `V32-DEC-016` forbids.** It is also *structurally unwritable*: the configured value is 0 and `award()` returns before the `INSERT`, so no row can ever have carried it — verified as zero rows. §3 replaces it rather than leaving a forbidden shape in a closed vocabulary for somebody to reach for.

**The `referral` notification category already exists and is already absent from `MANDATORY_CATEGORIES`.** `V32-DEC-033` requires it to be opt-outable; it already is. §11 adds templates and nothing else.

**The cap's calendar is the one parameter no closed decision pins precisely**, and §7 says so at length rather than choosing quietly.

## Decision

### 1. One consumer, one event, and three refusals that are the point

Qualification consumes **`BookingCompleted` v1 and nothing else** (`V32-DEC-018`).

The three refusals are not omissions and each is refused for its own reason:

- **Registration never qualifies.** V2's own design note and the roadmap refuse it outright.
- **`BookingConfirmed` never qualifies** — the service is still in the future.
- **`OrderPaid` never qualifies**, and `V32-DEC-018` calls this the sharper refusal: money moves *before* delivery and can be refunded within minutes, so qualifying on payment would maximise the window in which a reward exists for a service that never happened.

`V32-DEC-018` states the governing principle in one line — **booking is the qualification authority; payment is the reversal authority only** — and the repository enforces the asymmetry: `LEGAL_TRANSITIONS` makes `completed` terminal, so the booking fact can never be retracted, while a refund against the order remains possible indefinitely. That is precisely why Story #28 exists separately and why this story must not anticipate it.

Also refused, and each is a path a future author might reach for: **no booking-table polling**, no inference from `OrderPaid`, no client-triggered qualification route, no analytics-derived trigger, and no reading of loyalty rows to decide whether to write loyalty rows.

### 2. The qualification compare-and-swap

```sql
UPDATE referral.referrals
   SET status = 'qualified',
       qualified_at = $2,
       qualifying_booking_id = $3
 WHERE referee_user_id = $1
   AND status = 'pending'
   AND expires_at > $2
RETURNING id, referrer_user_id
```

**The predicate is the guarantee, and every clause earns its place.** `status = 'pending'` is what makes a redelivered event a no-op. `expires_at > $2` is **strict**: at `expires_at` exactly equal to the qualification instant the referral does **not** qualify, and both sides of that millisecond are tested. `referee_user_id` addresses the row from the event's `customerId`, so nothing is looked up first.

**The affected-row count is read through `returningRows`, never `result.length`.** This is not defensive style. TypeORM's PostgreSQL driver returns `[rows, rowCount]` for `UPDATE` **even with `RETURNING`**, so `result.length` is always 2 and a guard reading it never fires. That exact mistake has already shipped twice in this repository — `TokenService.rotate` let a **revoked refresh token mint a session** because `claimed.length === 0` was never true. Issue #12 names the trap explicitly; `sql-result.ts` exists because of it; this story uses the helper.

**A CAS loser produces nothing.** No counter increment, no grant, no ledger row, no outbox event, no notification. That is a property of ordering — the CAS is the first write and everything else is inside its success branch — rather than of a series of `if` statements.

### 3. Two reasons, two values, and why one of each would be a bug

`V32-DEC-016` is unusually specific and the reason is mechanical rather than stylistic:

```
uq_points_entries_reference_once (reference_type, reference_id, reason)
```

With **one** reason, the referrer's and the referee's rewards for **one referral id** collide in the same idempotency slot — the second one silently does not happen. So:

| Side | Ledger reason | Configured value |
|---|---|---|
| referrer | `referral_referrer_reward` | `LOYALTY_POINTS_REFERRAL_REFERRER` — **0** |
| referee | `referral_referee_reward` | `LOYALTY_POINTS_REFERRAL_REFEREE` — **0** |

**The reference is `('referral', <referral id>)`** — not the booking id. The guarantee being bought is *one reward per referral per side*, and the booking id would express *one reward per booking per side*, which is a different and weaker statement the moment a referee's second booking arrives.

**The existing single `referral_qualified` reason is removed**, not left beside the new pair. It is structurally unwritable today (value 0, `award()` returns before the `INSERT`, zero rows verified), so removing it destroys no history; and leaving an unused single-sided reason in a set the codebase calls a contract would put the one shape `V32-DEC-016` forbids within reach of the next author. The suite asserts no ledger row carries it.

**Both values are 0 and this ADR does not change them.** Not a roadmap example, not a legacy V2 figure, not a test fixture, and specifically not V2's `50`. A non-zero figure is a new owner decision; the tests that prove the paying path works inject values through configuration and never touch the default.

### 4. Ports, and the one that is deliberately absent

**`ReferralLoyaltyPort`** — declared by `referral`, bound at the composition root (ADR-011), and the only way this domain reaches the ledger:

```ts
interface ReferralLoyaltyPort {
  award(manager: EntityManager, input: {
    userId: string;
    reason: ReferralLedgerReason;
    referenceType: string;
    referenceId: string;
    points: number;
  }): Promise<{ awarded: boolean }>;
}
```

It takes the caller's `EntityManager` and passes it straight to `LoyaltyLedgerService.award(input, manager)`. It returns whether a row was written and **nothing else** — not the balance, not the lifetime total, not the tier. Those are facts about a person's whole loyalty history, and a referral handler has no business holding them; returning them would also put them one careless log line from a payload `V32-DEC-033` forbids.

**There is no booking port**, and §Context records why: `BookingCompleted` already carries `customerId` and `bookingId`. A port here would be a seam nothing crosses.

**There is no order port and no refund port.** Those are Story #28's, and building either now would be building the story this one is required not to start.

### 5. One transaction, and what is inside it

The handler opens **one** transaction — the relay dispatches handlers with no ambient transaction, so the handler owns it — and every effect below commits or rolls back together:

1. the qualification CAS (§2);
2. the qualifying booking snapshot and qualification instant, written **by the same statement**, so a qualified referral without its booking is unrepresentable rather than merely unlikely;
3. the monthly counter's conditional increment (§7);
4. the **referrer** reward grant row;
5. the **referee** reward grant row;
6. the referrer ledger award, when configured positive **and** uncapped;
7. the referee ledger award, when configured positive;
8. the `ReferralQualified` outbox row.

**Every port method takes the caller's manager and uses it.** A port that opens its own connection inside a caller's transaction is the defect V3.2-B recorded as **bug #2**, where N concurrent senders needed 2N connections against a pool of 10 and past five the suite *stopped* — no error, no timeout. This handler runs on at-least-once delivery, so it is exactly the shape that reproduces it.

**No domain service may use its default repository connection here.** `LoyaltyLedgerService.award` without a manager opens its own transaction, which would commit a ledger row that a later rollback could not take back — the one failure mode that turns a replay-safe design into a double payment.

### 6. Independent sides, and a closed outcome vocabulary

The two sides are **modelled and persisted independently**, because `V32-DEC-019`'s owner correction is explicit: *both grants must not be skipped merely because the inviter reached their cap*, and *an invited customer must never lose their own approved reward because of somebody else's activity*.

```
referral.reward_grants
  referral_id + side  -> UNIQUE           (one grant per referral per side)
  side       : 'referrer' | 'referee'
  outcome    : 'awarded' | 'disabled_zero' | 'capped'
  points     : the CONFIGURED value at qualification time
  reason     : the ledger reason this side would use
  granted_at
```

The vocabularies are **closed enums**, `CHECK`-constrained in the database and exported from the contract package. No free-form status string, and no `NULL` meaning "something happened".

- **`awarded`** — a positive configured value was actually written to the ledger.
- **`disabled_zero`** — the configured value is 0. The grant row exists and records the zero honestly; no ledger row and no idempotency slot (§8).
- **`capped`** — the referrer's monthly cap was already spent. Referrer side only, by construction: the referee side has no cap.

**`points` records the configured value at qualification time**, which is what makes the row an *explanation* rather than a restatement. A grant reading `disabled_zero, points 0` says the platform decided, on that date, to award zero — which is a materially different claim from silence, and is the audit trail `V32-DEC-016`'s "honestly disabled" requires.

### 7. The monthly cap, and the calendar question this ADR does not pretend is settled

`V32-DEC-019`: **10 qualified referrals per referrer per Tehran calendar month. No lifetime cap.** Charged by one conditional statement, the third time this repository has used the shape (`chat.send_counters`, `referral.claim_attempts`, now this):

```sql
INSERT INTO referral.referrer_counters (referrer_user_id, period, qualified_count)
VALUES ($1, $2, 1)
ON CONFLICT (referrer_user_id, period) DO UPDATE
  SET qualified_count = referral.referrer_counters.qualified_count + 1,
      updated_at = now()
  WHERE referral.referrer_counters.qualified_count < $3
RETURNING qualified_count
```

Zero rows returned means the cap is spent, and the referrer side is marked `capped`. **Never a read-then-write**, which `V32-DEC-019` calls `GAP-04` reproduced knowingly; never an in-memory counter, the HTTP throttler, Redis, or a process-local mutex, each of which is per-process while the instance count is `THROTTLE-STORE`-unresolved.

**The boundary, stated so it is testable:** qualifications 1–10 in a period are within the cap; the 11th is `capped` for the referrer while the referee is still paid; the next period starts a fresh counter row; and there is no lifetime cap, so period *n+1* is unaffected by how many periods came before.

#### The calendar, flagged rather than assumed

**`period` is the Gregorian year-month evaluated in `Asia/Tehran`** — `YYYY-MM`, from the runtime's IANA database, never the server's local zone.

This ADR records that as an **engineering interpretation of an owner phrase, not a ratified parameter**, because the phrase admits two readings and they are materially different:

- **Gregorian month in Tehran** — what `ai`'s `tehranCalendarDay` does for its per-day quota, and what this implements.
- **Jalali (Solar Hijri) month** — Iran's official calendar, which this repository fully supports (`toJalali`, `PLATFORM_TIMEZONE`), and whose months begin around the 21st of a Gregorian one. `packages/persian-utils/src/format.ts` states that the platform "uses the Jalali (Solar Hijri) calendar, **never Gregorian**" for user-facing dates.

The two windows differ by roughly three weeks, so a capped referrer's allowance resets on a materially different date under each.

**Why the `ai` precedent does not actually settle it:** for a *day*, Gregorian-in-Tehran and Jalali-in-Tehran are the **same window** — only the label differs. The precedent has therefore never been exercised on the question a *month* asks.

**Why this ADR chooses rather than blocks.** Both configured values are **0**, so the cap has **no financial effect whatsoever today**: a capped referrer is paid nothing, and an uncapped one is paid nothing. The choice becomes material only when a non-zero reward is enabled, which is itself a separate owner decision that this story does not make. Choosing now, documenting the alternative, and flagging it is the same course `ADR-035` §3 took with the code format — which the owner subsequently ratified as `V32-DEC-034`.

**It is cheap to change now and expensive later**, and the reason is worth stating precisely: the period is a plain `VARCHAR` bucket key with no rows that have ever gated a payment, so switching calendars today is one function and a backfill of nothing. Once a non-zero reward has been paid under one calendar, changing it re-cuts a window people were paid against. **If the owner intends Jalali months, that is a new decision-register entry, not a refactor.**

### 8. Zero is honestly disabled, and that is load-bearing

When a side's configured value is 0:

- qualification **is** recorded on the referral row;
- the reward grant **is** recorded, with `outcome = disabled_zero` and `points = 0`;
- **no loyalty row is inserted**;
- **no idempotency slot is consumed**;
- no zero-point transaction is fabricated and no balance moves.

The last two are the load-bearing half, and `V32-DEC-016` says why: a later real figure **must still be awardable against the same referral id**. A zero row would occupy `(referral, <id>, referral_referrer_reward)` permanently, and the award that the business eventually approves would be silently deduplicated away — a bug that would surface as "we turned the reward on and nobody got anything", months after the code that caused it shipped.

`LoyaltyLedgerService.award` already behaves this way and its docblock already names `pointsReferralQualified` as the reason. This story's contribution is to **prove it structurally against the real table** rather than trust the comment: the suite asserts zero rows exist for the reference *and* that a subsequently-enabled positive value still awards against the same referral id.

### 9. The financial boundary is preserved by not being touched

`loyalty.points_entries` is owned by **`beauclick_app`**, not by `beauclick_financial_owner`. The points ledger and the **financial** ledger are different objects: `financial.ledger_entries` is money, is owned by a separate role, and has `UPDATE`/`DELETE` revoked from the application role (ADR-017).

Story #12 touches **neither** the financial schema nor the loyalty schema:

- no loyalty migration is required, because `reason` is `VARCHAR(64)` with **no CHECK constraint**;
- referral reaches the ledger only through `ReferralLoyaltyPort` → `LoyaltyLedgerService`, the existing authorised path;
- referral acquires **no direct grant** on any loyalty or financial table.

So the boundary is preserved by construction, and the suite verifies it rather than asserting it: the financial roles' ownership and the application role's lack of financial privileges are re-checked after this story's migration.

### 10. `ReferralQualified` v1, and the payload prohibitions

One event. `V32-DEC-033` approves `ReferralQualified` v1 and `ReferralReversed` v1 **and nothing else**; the second is Story #28's.

```ts
{
  referralId, referrerUserId, refereeUserId, qualifyingBookingId : uuid
  qualifiedAt                                                    : instant
  referrerOutcome, refereeOutcome                                : closed enum
  referrerPoints, refereePoints                                  : int >= 0
}
```

**Identifiers, closed enums, integer point values, and instants — and structurally nothing else.** No referral code, phone, display name, email, booking note, notification copy, free prose, internal rejection reason, balance, or tier name. A referral code is a bearer credential and never leaves the authenticated read route (`V32-DEC-033`, ADR-035 §8).

The suite **walks the registered schema** rather than reading the source, asserting every field is a uuid, an instant, a bounded integer, or a member of a closed enum — so a `z.string()` added later fails even if nobody reads the diff. That audit is paired with a **negative control**: the same walk is run against a deliberately planted prose field and must reject it, because a schema audit that cannot fail proves nothing.

**`referral.outbox_events` is created by this story**, and its earlier absence was correct rather than an oversight: ADR-035 §7 and ADR-036 §10 declined to create an outbox table for an event with no consumer. `ReferralQualified` has one (§11), so the table arrives with its first producer.

Still **not** defined and **not** emitted: `ReferralAttributed` (no consumer — unchanged), `ReferralRewarded` (the reward is a field on qualification, not a second fact), `ReferralCapped` and `ReferralExpired` (states, not events, and nothing consumes them), and every reward-adjustment event.

### 11. Notification: in-app, opt-outable, and carrying no prose from the event

`V32-DEC-033`: referral notifications are **in-app only**, under the existing **opt-outable** `referral` category, which is *deliberately absent from* `MANDATORY_CATEGORIES` and stays that way. It already exists and already is; this story adds templates and changes no category.

**Recipients: both parties, each told about their own referral.** `V32-DEC-033` describes the moment as telling *"somebody what happened to their own referral"*, and both sides have one. Neither message names or implies the other party — the same asymmetry `V32-DEC-019` binds for exports.

**The copy lives in the template registry and is built from closed event fields inside the consumer.** The event carries no prose and `requiredVars` is empty, so there is no variable a display name, a code, or a points figure could travel through — the shape `chat_message_received` already established.

**No points figure is stated**, and that is a correctness decision rather than caution: with both values at 0, a message saying anything was earned would be false. The templates state the **qualification** fact, which is true regardless of the configured economics.

**No administrator notification** is invented, and no SMS, email, push, or external provider is touched — all externally gated (`V32-DEC-033`, dependency-ledger rows 6 and 7).

**A notification failure must not corrupt the committed ledger transaction.** The notification is produced by a *consumer of the outbox event*, downstream of the transaction in §5, so a delivery failure retries through the existing outbox/consumer model against an already-committed, already-correct ledger.

### 12. Replay, duplicates, and concurrency

The outbox is **at-least-once by design**; redelivery is the steady state, not an exception (`V32-DEC-019`).

- **Duplicate delivery** — the CAS finds `status = 'qualified'`, affects zero rows, and the handler returns having written nothing.
- **Concurrent duplicate delivery** — one CAS wins at the row lock; the loser observes zero affected rows. One qualification, one counter increment, one grant per side, one ledger effect per side, one outbox event.
- **A later `BookingCompleted` for the same referee** — the same no-op, for the same reason. Qualification is once per referral, not once per booking.
- **The grants are additionally `UNIQUE (referral_id, side)`**, so even a code path that reached them twice could not write two.

The cap is not double-counted, because the increment lives inside the CAS's success branch: no qualification, no increment.

### 13. What this story is NOT

**No reversal and no clawback.** No `OrderRefunded` consumer, no refund handler, no order-lookup port, no negative ledger row, no balance-below-zero behaviour, no lifetime-earned or tier reversal, and no `ReferralReversed`. Story #28, whose trigger, port, and open question are all different — `V32-DEC-017` decides the reversal *policy*, and this ADR deliberately does not begin its implementation.

The one thing this story does for Story #28 is **persist `qualifying_booking_id`**, so the reversal story can identify the qualifying order without guessing or scanning historical events. That is a column, not a behaviour.

**No manual review, appeal, or administrator override** — refused outright by `V32-DEC-019`.
**No device, IP, browser, or fingerprint signal** — refused outright by `V32-DEC-019`; no column could hold one.
**No second points ledger, referral balance table, direct balance mutation, cash payout, wallet, or promo code.** The reward unit is loyalty points only (`V32-DEC-016`).
**No frontend, no design artifact, no `apps/web` change, no external provider, no release tag.**

## Consequences

- A referral qualifies exactly once, on the referee's first authoritative `BookingCompleted`, and the guarantee is a compare-and-swap whose affected-row count is read through the helper that exists because reading it wrongly has already shipped twice.
- The two reward sides are independent in the schema, in the vocabulary, and at the cap — so an invited customer never loses their own reward to somebody else's activity.
- Zero is disabled honestly: recorded, explained, and reversible, with the ledger slot left free for a figure the business has not yet chosen.
- The cap is bounded transactionally across every API instance, by the same conditional-write shape the platform now uses in three places.
- The financial role boundary is untouched, because the points ledger is a different object from the money ledger and neither schema needed a migration.
- Story #28 inherits a qualified referral that names its qualifying booking, two grant rows that explain what was and was not paid, and a counter it must decrement or not — a decision that ADR deliberately leaves open.

## What is deliberately not decided here

- **The reward figures.** Both are 0 and changing either is an owner decision, not a configuration convenience.
- **Whether "Tehran calendar month" means Gregorian-in-Tehran or Jalali** (§7). Implemented as the former, flagged for ratification, and materially inert while both values are 0.
- **Whether a reversal decrements the monthly counter.** Story #28's question, and a real one: a reversed referral that keeps its counter slot bounds payouts more tightly than one that returns it. Not prejudged here.
- **Widening qualification to a paid non-booking order** — `V32-DEC-018` keeps option (b) out while `commerce.orders.source_type` admits only `booking` and `direct`, because the branch would be unreachable and untestable.
- **Any notification beyond the qualified moment**, and any channel beyond in-app — externally gated.
