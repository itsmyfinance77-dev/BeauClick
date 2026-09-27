# F-10 complete fix (owner-approved option B) — design, recorded BEFORE implementation

DEMO BRANCH ONLY (`codex/demo-2026-09-28`). Not production/legal approval, not money-transfer authority. The demo's
manual execution is synthetic: nothing here moves money, calls a bank or reaches an external system.

## Problem (F-10) and the adjacent gap (F-11)

- **F-10.** A non-customer-cause cancellation's default refund can be `manual_required` (gateway without a refund API).
  ADR-051 §8 still lets the customer switch to a free reschedule, and the switch left the `manual_required` refund row
  standing → the platform owed both.
- **F-11 (found while designing; also affects the existing `pending` path of #212).** After a remedy reschedule, a LATER
  cancellation of the same booking found the old cancellation decision still "live", and `executeCancellation` skipped
  the refund because the order's remedy says `reschedule` → the customer would get no refund; the per-booking refund
  request key would also collide with the first round's row.

## State machines

### Refund row (`payment.refunds.status`)
```
pending ──► succeeded | failed | manual_required            (unchanged: PaymentService.completeRefund, CAS from pending)
manual_required ──► succeeded       (NEW: controlled manual execution recorded as EXECUTED; emits RefundCompleted — money moved)
manual_required ──► superseded      (NEW: #212 reschedule won; NO RefundCompleted; row kept with its amount for audit)
```
New column `manual_tracked boolean NOT NULL DEFAULT false`: set `true` only when the NEW code moves a refund to
`manual_required`. Existing (legacy/unknown) `manual_required` rows stay `false` → **never superseded** (not presumed
unpaid); they can still be claimed/executed by an operator.

### Manual execution claim (`payment.manual_refund_executions`, one ACTIVE row per refund)
```
(none) ─claim─► claimed ─► executed            (terminal; external reference recorded; refund → succeeded)
                   │  └──► uncertain ─► executed | released
                   └─────► released           (operator attests NO transfer was made; audited)
released rows stay as history; a new claim creates a new row.
```
Partial UNIQUE index: at most one row per refund in (`claimed`,`uncertain`,`executed`). **No timeout transition**
exists — a stale `claimed`/`uncertain` row blocks supersession until an operator resolves it.

### Cancellation decision (`commerce.booking_outcome_decisions.execution_status`)
```
pending ──► executing ──► executed | manual_required | failed   (NEW `executing`: durable claim before the gateway call)
pending ──► executed | manual_required | failed                  (kept for adopt/legacy paths)
pending ──► superseded           (NEW: remedy reschedule won before any execution started)
manual_required ──► superseded   (NEW: remedy reschedule won; refund row superseded in the same transaction)
manual_required ──► executed     (NEW: manual execution recorded)
```
A decision in `superseded` is consumed: a later cancellation creates a NEW decision that supersedes it
(`superseded_by_id`), with its own refund request key `booking-cancelled:<booking>:after:<old decision>`.

## Authorization
- Manual execution routes: `bc_execute_manual_refunds` (NEW capability; administrator only). Claim/resolve record the
  actor; refused for everyone else (403 by the capability guard; unknown refund → generic 404).
- Remedy reschedule: unchanged — the booking's customer only (`remedy` routes' existing ownership).

## Lock order and linearization
Global order (every path takes a prefix of it, in this order):
`remedy choice (order) → cancellation decision → refund row → execution claim → booking → slot`.
- **Automatic execution** (`executeCancellation`): short tx `decision FOR UPDATE; require pending|executing and remedy
  not reschedule-for-this-decision; CAS pending→executing` (**linearization point vs. the remedy**), commit; then the
  gateway refund (idempotent by request key); then `executing→<outcome>`. A crash after `executing` leaves the decision
  `executing` → blocks the remedy (fail-closed); redelivery resumes the same idempotent refund.
- **Manual claim**: tx `refund FOR UPDATE; require manual_required AND not superseded; no active claim; insert
  claimed` (**linearization point vs. supersession: the refund row lock**).
- **Remedy reschedule (supersession)**: one tx `remedy FOR UPDATE → decision FOR UPDATE; require pending or
  manual_required; if manual_required: refund FOR UPDATE, require manual_tracked AND status manual_required AND no
  claimed/uncertain/executed claim; booking reschedule (slot claim — failure rolls everything back); refund CAS
  manual_required→superseded; decision CAS →superseded; remedy CAS default→customer/reschedule; audit`.
Both race orders: claim-then-reschedule → reschedule refused `REMEDY_REFUND_IN_EXECUTION`; reschedule-then-claim →
claim refused `REFUND_NOT_CLAIMABLE`.

## Commitments, ceilings, projections
- `orderRefundCommitments` / refund ceilings count `pending`, `succeeded`, `manual_required` — never `failed` or
  `superseded`. A later cancellation after supersession therefore has the full captured amount available.
- `RefundCompleted` is emitted only for `succeeded` (automatic or recorded manual execution); never for `superseded`.
- Audit: `payment.refund_superseded_by_remedy`, `payment.manual_refund_claimed|executed|uncertain|released`,
  `commerce.customer_remedy_resolved`.

## Limits (stated plainly)
- A database lock cannot stop a person who transfers money OUTSIDE the system without first taking the claim. The
  design makes the claim the only recorded way to execute, and blocks supersession once a claim exists; it cannot
  detect an unrecorded out-of-band transfer. Operators must claim before transferring.
- The demo's "execution" is a synthetic record (no bank, no transfer).
- Replacement offer B is unchanged (independent new booking/payment).
