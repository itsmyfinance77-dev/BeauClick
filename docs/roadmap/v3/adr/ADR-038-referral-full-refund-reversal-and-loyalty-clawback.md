# ADR-038: Referral Reversal — Payment as the Reversal Authority, an Order-Lookup Port, and an Append-Only Clawback

**Status:** Accepted — implemented in V3.2-C Story #28 (referral full-refund reversal and loyalty clawback).
**Date:** 2026-09-01.
**Relates to:** ADR-037 (the qualification this reverses, and whose §13 reserved every decision below), ADR-036 (the attribution claim lifecycle), ADR-035 (referral code identity and the share boundary), ADR-011 (composition-root boundary), ADR-022 (event contracts and the transactional outbox), ADR-027 (subject-data contract and boot-time coverage), ADR-023 (the seller-of-record split the order carries), ADR-017 (why a guarantee that matters is enforced by the database), `V3_DATABASE_BLUEPRINT.md` §§1–4.
**Binding on:** `V32-DEC-017` (full refund only; partial never; `duplicate_charge` never; no time limit; append-only negative row under a distinct reason; balance may go negative and is never clamped; lifetime earned unreduced and no tier demotion), `V32-DEC-018` (**booking is the qualification authority, payment is the reversal authority** — this ADR is the second half of that sentence), `V32-DEC-016` (two sides, two reasons, two values, both **0**, and zero means honestly disabled), `V32-DEC-032` (the same ledger semantics, decided once for both this and the review clawback), `V32-DEC-033` (`ReferralReversed` v1 as an approved event, the payload prohibitions, and the in-app opt-outable notification boundary), `V32-DEC-019` (the per-referrer cap this ADR deliberately does not adjust — see §12).
**Does not decide:** the review-reward clawback (`V32-DEC-032` settles its *semantics* and schedules nothing), refund policy itself (Phase F blocker 15 decides *when* a refund is granted), any manual or administrative reversal surface, and **whether a reversal returns the referrer's monthly cap slot** — §12 states why that is left open rather than settled here.

## Context

ADR-037 §13 is unusually specific about what it was not doing: *"No `OrderRefunded` consumer, no refund handler, no order-lookup port, no negative ledger row, no balance-below-zero behaviour, no lifetime-earned or tier reversal, and no `ReferralReversed`."* Every one of those is this ADR. It also named the one thing Story #12 built ahead: `referral.referrals.qualifying_booking_id`, *"a column, not a behaviour"*.

Seven facts about the repository shaped what follows. Six were found by reading the code; the seventh was found by reasoning about the relay, and it is the only one that required a change to a shipped path.

**`OrderRefunded` v1 genuinely cannot address a referral, and the story is right about why.** Its payload is `{orderId, refundId, refundAmountToman, refundedTotalToman, currency, refundedAt}` — **no `customerId`, no `sourceType`, no `sourceId`**. There is no field a reversal could use to find out which booking, and therefore which referral, a refund concerns.

**`duplicate_charge` cannot reach this path at all, and that is stronger than a branch.** `RefundCompletedCommerceHandler` returns before calling `recordRefund` when the kind is a duplicate charge, and `OrderService.recordRefund` has **exactly one production caller** — that handler. So a duplicate-charge correction never increments `refunded_total_toman`, never moves the order's status, and never produces an `OrderRefunded` event. §3 records what this means for the port's shape, and why a duplicate-charge field would have been worse than no field.

**Full versus partial is already computed, authoritatively, by the database.** `recordRefundWithin` sets the status to `refunded` or `partially_refunded` by comparing `refunded_total_toman + amount` against `total_toman`, in the same statement that increments the total. The order's **status** is therefore the authoritative answer to "was this a full refund", and it is a fact the platform already maintains rather than one this story must derive.

**`reward_grants.points` is the BASE value, not what was credited.** `LoyaltyLedgerService.award` computes `Math.round(basePoints * multiplierBp / 10000)`, and `multiplier_bp` comes from the recipient's membership benefits at award time. A clawback of the grant's figure would therefore under-reverse every referral belonging to a customer holding a `bonus_points_multiplier` benefit, leaving a permanent residue that nothing would ever detect. §5 is the resolution.

**The ledger has no reversal path, and `award()` cannot be made into one.** It returns early at zero, it re-applies the multiplier, and it emits `LoyaltyPointsEarned` — which `analytics` sums into `loyalty_points_earned`. A negative row pushed through `award` would corrupt a gross-earnings metric with a clawback. §6 adds a reversal method to the **existing** ledger rather than building a second one.

**`loyalty.points_entries.points` is already signed and already documented as such** — *"Signed: a negative row is a redemption"* — and `lifetimeEarned()` already sums positive rows only. Two of `V32-DEC-017`'s hardest requirements are therefore properties the schema already has; this story's job is to prove they hold rather than to build them. `ck_points_entries_multiplier`, which requires `multiplier_bp >= 10000`, means a reversal row must still carry a valid multiplier, which §6 does by copying the original's.

**The relay makes out-of-order delivery real, and there is a race a naive implementation loses.** `OutboxRelay.drain` iterates sources in registration order and orders each by id; there is no cross-source ordering, and a handler that throws leaves its row unpublished for an arbitrarily later sweep. So `OrderRefunded` can be consumed **before** the `BookingCompleted` that qualifies the referral it concerns. §8 works through the interleavings, including one that needs a lock rather than a re-read.

## Decision

### 1. The trigger is `OrderRefunded`, and the authority split is preserved exactly

`V32-DEC-018` states it in one sentence: **booking is the qualification authority; payment is the reversal authority only.** This ADR implements the second clause and changes nothing about the first.

The consumer is `OrderRefunded` v1 — a **commerce** event, emitted inside the transaction that moved the order's refunded total. Not `RefundCompleted`, which is a payment-gateway fact that has not yet been reconciled against the order, and not `BookingCancelled`, which `V32-DEC-017` and the story both refuse: `LEGAL_TRANSITIONS` maps `completed` to an empty set, so a qualifying booking can never be cancelled and a cancellation trigger would be an unreachable branch no test could honestly cover.

**There is no public route, no administrative route, and no manual reversal surface.** `V32-DEC-019` refuses a review queue, an appeal workflow, and an override route in terms; a reversal endpoint would be all three at once. The only way a referral reverses is a full refund the platform has already recorded.

### 2. Full, and only full — read from the order, never from the event

The handler does **not** decide from the event's refund amount, and does not compare it to anything. It re-reads the authoritative order and branches on the order's status.

Three independent reasons, any one sufficient:

* **The event's amount is one refund, not the total.** A 50,000 refund against a 50,000 order is full; the same amount against a 200,000 order is not, and the payload alone cannot tell them apart without a second read anyway.
* **A sequence of partials becomes a full refund**, and the event that completes it looks identical to the ones that did not. The story says this exactly: *"`recordRefund` emits the same event for both, so the handler must branch on the resulting order status rather than on the event's existence."*
* **The order's status is already the platform's own answer**, computed by the database in the same statement that moved the money. Recomputing it here would be a second implementation of a rule that already has one, free to drift.

A **partial** refund therefore reverses nothing, and needs no branch to not do so: `partially_refunded` simply fails the predicate.

### 3. `ReferralOrderLookupPort`, and the field it deliberately does not have

`referral` may not import `commerce` (ADR-011, enforced by lint). It declares the narrowest thing it needs and `apps/api` binds it, exactly as `REFERRAL_LOYALTY_PORT` is bound.

```ts
interface ReferralOrderLookupPort {
  /** The order produced by this booking, or null. Locked FOR SHARE — see §8. */
  findBookingOrder(manager: EntityManager, bookingId: string): Promise<ReferralOrderFacts | null>;
}

interface ReferralOrderFacts {
  readonly orderId: string;
  readonly sourceType: 'booking' | 'direct';
  readonly sourceId: string;
  readonly fullyRefunded: boolean;
}
```

**One method, addressed by booking id**, because that is the only handle the referral domain legitimately holds: `referrals.qualifying_booking_id`. `commerce.orders` carries `UNIQUE(source_type, source_id)`, so a booking has at most one order and the lookup is exact rather than a search.

**The customer id is deliberately not returned.** The port could report it and the referral domain has no use for it: the referral row already names both parties, and the match is made on the booking, not on the customer. A customer id crossing this boundary would be an identity the reversal path holds for no reason, one careless log line from a payload `V32-DEC-033` forbids. The seller party, the amounts, and the currency are absent for the same reason — money detail has no business in a referral handler.

**`fullyRefunded` is a boolean computed from the authoritative status**, not the status string itself. The referral domain has no business knowing that `partially_refunded` and `cancelled` are different things; it asks one question and gets one answer.

**There is no duplicate-charge field, and that is the finding rather than an omission.** A duplicate-charge correction cannot move an order's status (§Context), so `fullyRefunded` is already false for it and always will be. A field reporting it would be a guard that can never fire — which reads, to the next author, as though the danger were being handled somewhere, and would invite them to rely on it. The exclusion is structural and is proved by an end-to-end test that issues a real duplicate-charge refund and asserts no `OrderRefunded` and no reversal, rather than by a field nothing can set.

**`OrderRefunded` v1 is not widened, and this is not a preference.** A payload change is a **new version, never an edit** (ADR-022). Widening v1 would silently redefine a contract every existing consumer is already parsing — `OrderRefundedLedgerHandler` among them — and oblige a review of each. Publishing a v2 to carry three fields one new consumer needs would put a versioning burden on the whole platform to save one composition-root adapter. The port is the cheaper and more honest instrument: it re-reads authoritative state, which the event could not do however wide it grew.

### 4. `qualified → reversed`, one compare-and-swap, database-enforced

```sql
UPDATE referral.referrals
   SET status = 'reversed', reversed_at = $2, reversal_order_id = $3
 WHERE id = $1
   AND status = 'qualified'
RETURNING referrer_user_id, referee_user_id
```

The predicate on the qualified state is the **only** guard, and everything else lives inside its success branch. A redelivered `OrderRefunded`, a referral that is still pending, and one already reversed all cost exactly one `UPDATE` affecting zero rows and write nothing at all.

The affected-row count is read through `returningRows`, **never `result.length`** — for the reason `sql-result.ts` records at length: TypeORM's postgres driver returns `[rows, rowCount]` for `UPDATE` *even with `RETURNING`*, so `result.length` is always 2 and a guard reading it never fires. That mistake has shipped twice in this repository, once letting a revoked refresh token mint a session.

**The reversal facts move with the status or not at all**, enforced by `ck_referrals_reversal_complete`: a reversed row must carry both `reversed_at` and `reversal_order_id`, and a row that is not reversed must carry neither. A crash between "marked reversed" and "recorded which order" is unrepresentable rather than unlikely.

**A refund id column is deliberately absent.** `OrderRefunded` carries one and persisting it looks free — but the convergence path in §8 reverses without any refund event in hand, so the column would be non-NULL on some reversed rows and NULL on others. A fact that is only sometimes present is a fact no audit can rely on and every reader must first learn the exception to. The order id reaches `payment.refunds` by its own `order_id` index anyway, so nothing is lost.

### 5. The clawback amount comes from what was persisted, never from configuration

`V32-DEC-017` and the story require that a later configuration change cannot alter what a past reward is worth on the way back out. Two persisted records answer two different questions, and conflating them is the trap:

| Question | Answered by | Why not the other one |
|---|---|---|
| **Does this side reverse at all?** | `referral.reward_grants.outcome` | The ledger cannot distinguish `disabled_zero` from `capped`; both wrote nothing. |
| **By how much?** | the original `loyalty.points_entries` row for this referral and reason | The grant holds the **base** value; the ledger holds what was actually credited, multiplier included. |

**The grant decides whether; the ledger decides how much.** Reversing the grant's figure would under-claw exactly those customers whose membership tier earned them a multiplier — the residue growing with the size of the benefit, and nothing anywhere would report it. Both sources are *persisted originals*; neither is current configuration, which is the property the rule exists to protect.

The two are **cross-checked rather than trusted**: the adapter asserts that the grant's points equal the original entry's base points and throws, naming neither party and no amount, if they disagree. A silent mismatch would mean the grant no longer explains the ledger row it exists to explain.

Per side, independently:

* outcome `awarded` **and** an original ledger row exists → one negative row of exactly the credited amount, under the reversal reason.
* outcome `disabled_zero` or `capped` → **no ledger call at all**. No zero-value row, no fabricated idempotency slot. `V32-DEC-016`'s honest zero is a property of the reversal path too: a zero reversal row would occupy the referrer or referee reversal slot permanently and silently deduplicate away the real clawback if a figure were later approved and then reversed.
* Either way, a **`referral.reward_reversals` row is written**, recording `reversed` or `nothing_to_reverse`. The audit trail states what happened to both sides even when one of them moved no points — the same reasoning that makes `reward_grants` write two rows when neither pays.

*"Reverse both sides"* therefore never means *"write two zero-point ledger rows."*

### 6. `LoyaltyLedgerService.reverse`, on the existing ledger

The clawback is a method on the **existing** service, not a second ledger. It:

* finds the original entry by reference type, reference id and the original reason, and returns a not-reversed result when there is none — a normal return value, since a `disabled_zero` side legitimately has nothing to reverse and a redelivery legitimately finds the slot taken;
* inserts one row whose points and base points are the negatives of the original's, with **`multiplier_bp` copied from the original** — required by `ck_points_entries_multiplier`, and correct regardless: the row states the multiplier the reversal is undoing;
* uses `insertOnce`, so the reversal reason's idempotency slot is the whole duplicate guard — never a read-then-write, and never `identifiers`, which TypeORM populates from caller-supplied values whether or not a row was inserted;
* runs on the **caller's `EntityManager`**, always;
* recomputes **no tier** and emits **no loyalty event**.

That last point is a decision rather than an omission. `LoyaltyPointsEarned` means *"points were credited for a real, already-happened domain fact"*, and `analytics` sums it into `loyalty_points_earned`; publishing a negative one would make a gross-earnings metric quietly net. `V32-DEC-033` approves `ReferralReversed` and nothing else, and that event carries the movement to anyone who needs it. Introducing a points-reversed contract would be adding an approved-by-nobody event to a closed vocabulary for a consumer that does not exist.

**Lifetime earned and tier need no code at all**, and that is the strongest form of the guarantee. `lifetimeEarned()` sums positive rows; a negative row is invisible to it, so no tier can be recomputed downward and no `LoyaltyTierChanged` can be emitted. `V32-DEC-017` accepts the consequence knowingly: *"a reversed referral leaves the referee tier-qualified on points they no longer hold."* Membership is a separate subscription object the ledger never writes. All four properties are asserted by test anyway, because a property that holds by accident is one refactor from not holding.

**The balance may go negative and is never clamped.** `balance()` sums every row, signed, with no floor — and adding one would convert *"book, get referred, spend the points, refund"* into a working exploit. The absence of a clamp is asserted directly, and the mutation probe that adds one must fail a test.

### 7. One transaction, and everything in it

The handler opens the transaction; every write takes that manager and no port opens a connection of its own:

1. the qualified-to-reversed compare-and-swap and its reversal facts;
2. both `reward_reversals` rows;
3. the referrer's negative ledger row, when there is one;
4. the referee's negative ledger row, when there is one;
5. the `ReferralReversed` outbox row.

A failure anywhere takes all five. The forced-failure test injects a throw between the two sides and asserts the referral is still qualified, both ledger rows are absent, no reversal row exists, and the outbox is empty — one clawed-back side with the other still standing is precisely the state an audit could never explain.

A port opening its own connection inside a caller's transaction is also the defect V3.2-B recorded as **bug #2**, where N concurrent callers needed 2N connections against a pool of 10 and the suite *stopped* past five with no error and no timeout.

### 8. Out-of-order delivery, and the one interleaving a re-read cannot fix

`OrderRefunded` and `BookingCompleted` come from **different outbox tables**, drained in source-registration order with no cross-source ordering, and a failed handler leaves its row for an arbitrarily later sweep. Refund-before-qualification is therefore an ordinary occurrence, not a pathology.

The naive handler loses that case: the reversal CAS finds the referral still pending, affects zero rows, and the qualification that follows leaves an active reward standing on a fully refunded order — the exact outcome `V32-DEC-017` calls *"a free-points loop"*.

**The fix is the same read at the other end, not a new mechanism.** The qualification transaction, after winning its CAS, asks the *same* port about the *same* booking, and if the order is already fully refunded it reverses immediately, in the same transaction. Booking still qualifies; payment still reverses; nothing polls, retries, or reconciles. The referral ends reversed, both events are emitted in the order the facts occurred, and a consumer sees a qualification followed by its reversal rather than a qualification that silently never happened.

That leaves one interleaving a re-read alone cannot close. Let *Tq* be the qualification transaction's order read, *Tc* the refund's commit, *Tr* the reversal CAS, *Tk* the qualification's commit. Both paths miss when *Tq* precedes *Tc*, which precedes *Tr*, which precedes *Tk*: qualification read the order before the refund committed, and the reversal CAS saw a row still pending.

**A `FOR SHARE` lock on the order row closes it**, and closes it by making the window unrepresentable rather than unlikely:

* qualification locks first → the refund's `UPDATE` blocks until the qualification commits, so the reversal handler runs afterwards and finds a qualified referral. It reverses.
* the refund locks first → qualification blocks until the refund commits, reads a fully refunded order, and reverses in-transaction.

No deadlock is possible: the refund path never touches `referral.referrals`, so there is no cycle. The lock is held for a short transaction on a row that is, by then, terminal.

The seven required interleavings and where each is decided:

| # | Interleaving | Outcome | Decided by |
|---|---|---|---|
| 1 | qualify, then full refund | reversed | the CAS |
| 2 | full refund recorded, then qualification consumed | reversed in the qualification transaction | §8 convergence read |
| 3 | both handlers concurrent | reversed exactly once | `FOR SHARE` plus the CAS |
| 4 | same refund event redelivered | one reversal | CAS affects zero rows |
| 5 | several full-refund deliveries racing | one reversal | CAS plus the ledger reason slot |
| 6 | partial, then full | reversed on the second only | order status, §2 |
| 7 | duplicate charge before or after | never reverses | structural, §3 |

**No new retry or reconciliation mechanism was required**, which the story made a condition. Every case is decided by a compare-and-swap, a row lock, or a unique index — all three already load-bearing elsewhere in this repository.

### 9. `ReferralReversed` v1

`V32-DEC-033` approves it by name, and this is its first publisher. The schema admits **no field a string could travel through**: uuids, an instant, closed enums, and non-negative integers. No referral code, no phone, no display name, no email, no prose, no free-text reason, no payment credential, and no order metadata a consumer does not need.

The reversed point figures are non-negative **magnitudes**, not negative numbers, and the bound is load-bearing in the mirror image of `ReferralQualified`'s: a payload admitting a negative here would let a *reward* be smuggled through the reversal event. The direction is carried by the event's name and by the reason on the ledger row, which is where direction belongs.

The order id **is** carried: it is the authoritative cause, it names no person, and a consumer that cannot see why a reversal happened is one that has to ask. The refund id is not, for §4's reason.

Written to the outbox inside the transaction, so a rollback takes it with everything else and no consumer can observe a reversal the ledger does not reflect.

### 10. Notification: in-app, opt-outable, self-side only

Two templates, one per side, under the **existing** `referral` category — which is already absent from `MANDATORY_CATEGORIES`, so a customer who has switched referral notifications off receives neither, and `NotificationService` suppresses rather than fails.

Neither template takes a variable. Neither message names, implies, or is addressed to the counterparty, and there is **no variable a points figure, a code, a name, or an order id could travel through** even if a later author wanted one. With both configured values at 0 today, a message stating an amount was taken back would be false; the templates state the outcome, which is true whatever the economics are.

The entity id is the referral id for both, and the recipient distinguishes the two idempotency keys — so `NotificationService.notify`'s own uniqueness over template, entity and recipient makes a redelivered `ReferralReversed` re-notify nobody. **No SMS, no email, no push, and no external provider**: every one of those is externally gated, and none is approved.

The handler is a **consumer of the committed event**, not part of the transaction — a notification outage must not roll back a clawback the ledger has correctly applied.

### 11. Privacy, and the new table's disposition

`referral.reward_reversals` is **`retained`**, with the same reason `V32-DEC-019` gives `reward_grants`: it explains a retained loyalty ledger entry. A negative points row with no record accounting for it would be a balance nobody could justify to the person holding it — and a *negative* balance with no explanation is worse than an unexplained positive one.

It is added to the subject-data contract **in the same commit as the migration**, because ADR-027's boot-time coverage fails both ways: an unclaimed table is a `no_claim` violation, and a claim for a table that does not exist is `claimed_but_absent`. Its recipient column carries the `_user_id` suffix, so a `no_subject_data` claim on it would fail at boot on the strength of the column name alone.

It joins the subject's **export** as part of the existing `referral_rewards` section rather than as a new one: the reversal is the second half of the same fact, and a person reading their own record should see "you were awarded this, and it was later reversed" in one place. Side, outcome, points and the reversal instant — never the referral id, never the order id, and never the counterparty, matching the asymmetry `V32-DEC-019` binds for the two export shapes.

**Erasure retains it and tombstones nothing**, because there is nothing on the row to tombstone: ids, a closed enum, an integer, an instant. The reversal columns on `referral.referrals` change nothing about that table's existing retained-with-tombstone disposition.

**No personal prose is written anywhere** — not on the reversal row, not on the outbox row, not in an exception message. The trigger raises by naming a column set, never a value.

### 12. What this ADR deliberately does not settle

**Whether a reversal returns the referrer's monthly cap slot.** ADR-037 left it open in as many words — *"a counter it must decrement or not — a decision that ADR deliberately leaves open"* — and none of `V32-DEC-016`, `-017`, `-018`, `-019`, `-032` or `-035` answers it. Both readings are defensible: returning the slot treats the cap as *"ten rewards that stuck"*, keeping it treats the cap as *"ten qualifications processed"*, and the second bounds payouts more tightly.

This story therefore **does not touch `referral.referrer_counters`**, and that is the null action rather than a quiet choice of the second reading. Deciding it would be inventing a policy under cover of implementing one — the same failure `V32-DEC-035` was created to correct, where an unratified reading of "Tehran calendar month" shipped as though it had been chosen. The question is recorded here so it is asked rather than discovered, and a decision either way is a one-statement change to a path that is already transactional.

### 13. What this story is NOT

**No review-reward clawback.** `V32-DEC-032` decided its *semantics* and explicitly *"does not schedule the implementation"*; no story exists and it is not V3.2-C scope. The ledger method added in §6 is general enough to serve it, which is a consequence rather than a plan.

**No refund policy.** Phase F blocker 15 decides *when* a refund is granted. This story reacts to one already authoritatively recorded, which is why `V32-DEC-017` corrects the dependency ledger to say the story is *"buildable, not externally blocked"*.

**No reversal endpoint, no manual compensation tooling, no administrative override** — refused by `V32-DEC-019`.
**No booking-cancellation trigger** — unreachable, since `LEGAL_TRANSITIONS` maps `completed` to an empty set.
**No `OrderRefunded` v2** and no widened v1 — §3.
**No second loyalty ledger, referral balance table, direct balance mutation, cash payout, or wallet.**
**No reward-value change.** Both remain **0**; a non-zero figure is an owner decision.
**No frontend, no design artifact, no external provider, no deployment, no release tag.**
**Stories #13, #14 and #15 are not started.**

## Consequences

- A full refund of a qualifying booking's order reverses both sides exactly once, and the guarantee is a compare-and-swap whose affected-row count is read through the helper that exists because reading it wrongly has already shipped twice.
- A partial refund and a duplicate-charge correction reverse nothing — the first by the order's own authoritative status, the second because it can never produce the event at all.
- The clawback is append-only: the original positive rows are never touched, and the negative rows occupy their own idempotency slots under two distinct reasons.
- The amount survives a configuration change, and survives a *multiplier* change too, because it comes from the ledger row rather than from the base figure the grant recorded.
- A spendable balance may go negative and is never clamped, closing the "book, get referred, spend, refund" loop.
- Lifetime earned, tier, and membership are untouched — by the shape of the query rather than by a guard, and asserted anyway.
- Refund-before-qualification converges, without a new retry or reconciliation mechanism, and without moving either authority.
- The referrer's monthly cap slot stays spent, and §12 records that this is an open question rather than a decision.
