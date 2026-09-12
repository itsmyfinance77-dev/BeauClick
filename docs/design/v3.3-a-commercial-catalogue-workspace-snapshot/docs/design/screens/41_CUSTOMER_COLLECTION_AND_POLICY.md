# 41 — Customer: collection modes, disclosure, payment states, cancellation and dispute

**Prototype:** `Prototype - Customer.dc.html` §21, §22, §23
**Baseline:** `6695234eded1` (revised 2026-09-12)
**Stories:** #41a, #81, #82 (sandbox), #83, #104 and **#115 — all merged and closed**. #42 (`gate:legal`), #43 (`gate:external`), #47 and #99 remain blocked.

> **Correction, 2026-09-12.** The first version of this spec recorded #115 as `status:proposed`. That was wrong when written: `commerce/src/order/order.service.ts` already resolved the collection policy through `BookingCollectionPolicyResolver` and snapshotted `policyKey`/`policyVersion` on the order schedule. **The backend for all three collection modes is complete; what does not exist is the customer-facing UI.**

## 1. What the customer may be shown, and what may not be invented

The customer never selects a collection mode. The mode is resolved by the server from the policy
the seller accepted, and `V33-DEC-031` requires the recorded mode to be **derived from the computed
amounts** rather than copied from the policy terms — because a percentage flooring to zero, or a
fixed amount clamped to the service total, legitimately produces a different mode than the terms
suggest. The design therefore never labels a booking's mode from a seller setting.

## 1-a. What #115 actually does, and the boundary that remains

At order creation, inside the order transaction: an **unenrolled** seller party keeps the named full-online path and writes `policyKey`, `policyVersion` and `policyAcceptedAt` all NULL; an **enrolled** party resolves the version active at the database clock instant and snapshots it immutably, or **fails closed** — there is no post-lookup fallback and no seed policy. Later publication or retirement never reinterprets an existing order.

`GET /v1/orders/:id` deliberately does **not** return `policyKey`, `policyVersion` or `policyAcceptedAt`. The customer is shown the three amounts and the collection mode, never the policy identifiers. Any screen wanting to name a policy version would need a contract change.

`policyAcceptedAt` stays NULL for every row: #115 snapshots, it does not accept. Acceptance is #42's, after Legal.

**Frontend boundary.** The receipt renders the three amounts today. The pre-confirmation disclosure and the collection-mode-aware checkout are **designed only** — the backend supports them now, so this is the highest-value unbuilt frontend work on the customer surface.

## 2. Amount rules (binding, from the merged contract)

1. Select the administrator-published base — exactly `service_subtotal` or `service_total`.
2. BigInt floor division, so rounding never collects more than the stated proportion.
3. Clamp up to the minimum.
4. Clamp down to the maximum when one is published.
5. Clamp down to the service total, always and last.

Venue balance is `serviceTotal − platformCollectible`, always. It is never a receivable, a
liability or revenue, and it can never be refunded because it was never collected.

## 3. Disclosure block — ten rows, four implemented

Implemented: legal seller identity, full service price, amount collected online, venue balance,
support route. Unavailable and rendered as `منتشرنشده — در انتظار تأیید حقوقی`: cancellation
deadline, possible retained amount, no-show grace period, reschedule terms, dispute deadline.
Policy version and acceptance: the control is disabled with its reason exposed via
`aria-describedby`. `commerce.order_payment_schedules.policy_accepted_at` is NULL for every row by construction and neither #104 nor #115 writes it — #115 is merged and this remains true, because snapshotting a policy is not accepting one.

**No row is hidden when unavailable.** A missing row would read as "this does not apply."

## 4. Vocabulary discipline

`بیعانه` (prepayment of part of the service price), `مبلغِ نگهداری‌شده`, `بازپرداخت`, `کمیسیون`,
`اعتبارِ نوبت` and `تسویه` are distinct terms and never synonyms. The words
**غیرقابلِ استرداد** and **جریمه** appear nowhere: the legal nature of the retained amount is
question 4 and is not approved.

## 5. Payment and refund states (§22)

`online_collection_not_required` · pending · succeeded · `online_collection_completed` (partial
capture, sandbox) · failed with eight reasons · unresolved callback (no automatic-resolution
promise — no reconciliation sweep exists) · refund pending (no read route) · refund completed ·
partial refund (structure only) · payment unavailable · provider incident (no provider named) ·
policy unavailable and fail-closed (no silent fallback).

Refund ceiling is the **collected** amount, enforced in PostgreSQL as
`0 ≤ refunded ≤ collected ≤ total`.

## 6. Cancellation, reschedule, no-show, force majeure (§23)

Today's safe behaviour, stated plainly on screen: **no retention, full refund of the entire
remaining collected amount.** Provider and platform cancellation refund 100% of collected money and
return exactly one seller booking credit. Reschedule transfers the same credit and never consumes a
second one — that part is binding. Whether the deposit transfers or the cancellation rule applies is
open. No-show is recordable only after the slot ends, and a seller's unilateral declaration is not
sufficient for a definitive transfer of money.

## 7. Dispute (§23)

Designed in full — submit, evidence with privacy warning, held amount, review, decision, one-level
appeal, retention — and backed by **no contract of any kind**: no capability, table, service, route
or event exists. The submit control is disabled. Evidence copy names only system data and party
statements, with sensitive files by necessity; body imagery, location and medical information are
not defaults and treatment records are out of scope. Retention and deletion wording is deliberately
unwritten pending legal and privacy approval.

## 8. Open options shown, none chosen

Provider/platform cancellation outcome (4 options, recommendation marked), objection window
(5 options), amount frozen during a dispute (3 options). Each option states which component changes
under it, so the final choice needs no redesign.
