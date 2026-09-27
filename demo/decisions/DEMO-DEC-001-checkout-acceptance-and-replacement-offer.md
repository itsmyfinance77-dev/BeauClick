# DEMO-DEC-001 — Web checkout acceptance (A) and durable replacement offer (B)

**Status:** approved by the owner for the internal team demo on 2026-09-27 (Codex relay of the owner's explicit
approval; plan section "Owner-approved scope extension — 2026-09-27"). **Demo branch only**
(`codex/demo-2026-09-28`); never merged to master automatically. This record does **not** amend ADR-051, ADR-044
or any production decision, and is not evidence that these flows are production-approved. Legal/release gates and
the exact-SHA Codex review remain in force. No authority beyond A and B is taken.

Last working artifact before this work: **A0** = artifact L built at `ada1d1f` (v3 tree identical to `b2477a3` + the
three demo seams), with the golden backup taken after seeding. It stays runnable for rollback throughout.

---

## A. Actual customer acceptance in web checkout

### What exists at the baseline (unchanged)
- `GET /v1/checkout/disclosure?professionalId&slotId&serviceId` returns `BookingOutcomeDisclosureV1`:
  `acceptanceRequired`, the numeric terms, the published customer-policy copy, and `acceptance`
  (`policyKey, policyVersion, copyKey, copyVersion`) — or `acceptanceRequired:false, outcome:null, acceptance:null`
  for an unenrolled seller.
- `POST /v1/bookings` accepts `acceptedPolicy` (exactly those four identifiers). `OrderService.requireAcceptance`
  refuses a missing, unexpected or mismatched acceptance with the non-enumerating
  `409 SERVICE_UNAVAILABLE_FOR_SALE`, and the snapshot (with the acceptance) is written in the booking transaction
  (`commerce.order_outcome_terms`).
- The web never called the disclosure and never sent `acceptedPolicy` ⇒ governed sellers were unbookable from web.

### Change (web + one additive read route)
1. After a slot is chosen and before any payment, the web loads the disclosure. While loading: no confirm button.
   On failure: an error state, **no payment can start**.
2. `acceptanceRequired:true` ⇒ render the terms (cutoff instant in Tehran time, late-cancellation and no-show
   retention, grace, free reschedules, dispute window) and the published copy body; an **unchecked** checkbox
   ("I have read and accept these terms"); confirm disabled until checked. The four identifiers sent are exactly
   the disclosed ones.
3. `acceptanceRequired:false` ⇒ no terms shown and **nothing** sent (never fabricate terms).
4. On `409` from a governed booking: reload the disclosure. If the identifiers changed ⇒ show the new terms,
   **clear the checkbox**, explain that the terms changed and require renewed acceptance. If unchanged ⇒ the
   ordinary "not bookable now" error. Never re-submit on the customer's behalf.
5. Booking details: new owner-scoped `GET /v1/orders/:id/accepted-terms` returns the order's snapshotted terms,
   identifiers, `acceptedAt` and the copy body of the accepted copy version (or `governed:false`). `/bookings`
   shows them in the booking's detail panel.

### A tests
Unit (web, jsdom): checkbox unchecked by default; confirm disabled until checked; identifiers sent verbatim;
unenrolled sends no `acceptedPolicy`; disclosure failure blocks payment; 409 + changed version clears acceptance and
shows new terms; 409 + same version shows generic error. API/DB (real demo API): missing / stale / exact acceptance
→ 409 / 409 / 201 with snapshot row; accepted-terms read by owner 200, by another customer 404. Browser (desktop +
390 px): governed booking end to end through the sandbox bank; version change during checkout; details panel.

---

## B. Durable replacement offer after provider-side cancellation

### Distinction from #212's existing seam (unchanged)
`commerce.customer_remedy_choices` (#161/#212) lets the customer choose `reschedule` **instead of** the refund, only
while the cancellation decision's `execution_status` is `pending` or `manual_required`; it is resolved to the
default refund at cancellation. That seam is **not** removed or rewritten. (Earlier progress notes called it
"unreachable"; precise statement: reachable only in that pre-execution window, which the sandbox closes almost
immediately.) The new offer is a **separate** record that does **not** compete with the refund.

### Money: can the existing payment be transferred to the replacement booking?
Required precondition: no irreversible refund commitment yet, and a provably atomic transfer primitive in the payment
/accounting contract. Analysis of the baseline:
- `decideCancellation` commits the refund decision in the cancellation's own transaction and `executeCancellation`
  issues the refund immediately afterwards (no waiting period) — by the time a customer can act, the refund is
  committed/submitted.
- There is **no** primitive that reallocates a captured payment from order O1 to a new order O2 (payment intents,
  attempts, ledger allocation and settlement are all per order). Building one would be inventing a financial
  primitive.
**Decision:** transfer is **not implemented**. Limitation reported. The approved fallback is always used: the original
refund continues untouched, and the replacement is an independent booking with its own payment. The UI discloses
that the customer may pay for the replacement before the earlier refund arrives, and never claims funds were moved.

### Data (new demo migration `commerce/20260927900001_create_replacement_offers.sql`)
- `commerce.replacement_offers` — one per provider-caused cancellation of a booking that has an order:
  `original_booking_id` PK, `original_order_id`, `customer_id`, `professional_id`, `service_id`, `offered_at`,
  `status ∈ {open, used, dismissed}`, `resolved_at`, `replacement_booking_id` (UNIQUE, set iff `used`).
- `commerce.replacement_offer_attempts` — every replacement booking attempt: `booking_id` PK,
  `original_booking_id` FK, `idempotency_key`, `created_at`; UNIQUE(`original_booking_id`, `idempotency_key`).
- Both claimed by the commerce subject-data contract (customer-linked; retained with the order history like the
  remedy table).

### State machine
```
                 provider/platform cancellation (same txn as the decision + #212 default remedy)
                                   │
                                   ▼
          ┌──────────────────── open ─────────────────────┐
dismiss   │  attempt: new booking (pending) linked;       │  a linked attempt CONFIRMS
(no active│  at most ONE attempt whose booking is pending │  (payment captured before hold lapse)
 attempt) ▼                                                ▼
     dismissed                                            used  (replacement_booking_id = that booking)
```
- `open` → attempt: allowed only if no linked attempt booking is `pending`; a declined/cancelled payment leaves the
  booking `pending` until its hold lapses (the existing payment-retry route applies to it) or the customer cancels
  that pending booking; a lapsed (`expired`) or cancelled attempt frees the offer. The offer is **never** consumed
  by a failed attempt.
- `used` is derived from the truth: a linked attempt booking with `confirmed_at IS NOT NULL`. A capture after the
  hold lapsed never confirms (existing checkout: auto-refund), so at most one attempt can ever confirm while the
  single-active-attempt rule holds. The row's `status` is persisted to `used` under the offer lock whenever this is
  observed (read, attempt, dismiss); the booking fact is the source of truth.
- `dismissed`: only from `open` with no pending attempt. Refund unaffected.
- No expiry. Service or provider inactive/deleted ⇒ the offer stays `open` but attempts are refused
  (`REPLACEMENT_NOT_AVAILABLE`), shown honestly; the refund is never withheld.

### Lock order (deadlock-free against the payment callback)
Attempt transaction: **offer row `FOR UPDATE`** → (existing checkout) slot/booking → order. The payment callback path
never locks the offer (the `used` state is derived, not written by the callback), so no cycle exists. Dismiss and
read-with-persist lock only the offer row. The linearization point of "one successful replacement" is the booking
confirmation itself (existing, single-winner); the offer lock linearizes attempt creation.

### API (all owner-scoped by the offer's `customer_id`; anything else is `404`, non-enumerating)
- `GET  /v1/bookings/:originalId/replacement-offer` → status, service (name, **current** price, active), provider
  (name, active), eligibility + reason, active attempt (booking id/status), replacement booking id, refund
  execution status of the original, disclosure flags.
- `POST /v1/bookings/:originalId/replacement-offer/bookings` (header `Idempotency-Key`, body `{slotId,
  acceptedPolicy?}`) → same response shape as `POST /v1/bookings`. Slot must belong to the same professional and
  service. Terms: the replacement's **own current** acceptance (A). Price: current. No reschedule counter touched.
  Same key replay → the same attempt (no second booking/charge).
- `POST /v1/bookings/:originalId/replacement-offer/dismiss`.
Error codes: `REPLACEMENT_OFFER_NOT_OPEN`, `REPLACEMENT_ATTEMPT_IN_PROGRESS`, `REPLACEMENT_NOT_AVAILABLE`,
`REPLACEMENT_SLOT_NOT_ELIGIBLE`, plus the existing checkout refusals (slot taken, acceptance).

### UI (`/bookings`)
On a provider-cancelled booking: refund status (existing #212 panel) **and** a separate replacement-offer panel:
"your refund continues regardless"; pick a slot of the same service/provider (live availability); current price;
the new booking's own terms with unchecked acceptance (A); explicit disclosure that payment happens now and the
earlier refund may arrive later; dismiss. After use: link to the replacement booking; the original stays cancelled.

### B tests
Real API + DB (a temporary uncommitted-DB pg-style suite against a disposable database in the demo cluster, plus
live demo API checks): offer created once per provider cancellation (redelivery idempotent), none for customer
cancellation; ownership 404; dismiss; attempt with slot of another provider/service refused; inactive service;
concurrent attempts (one wins, other `IN_PROGRESS`/slot-taken); same idempotency key replay; declined payment keeps
offer open + retry; lapsed hold frees offer; late capture after lapse auto-refunds and does not use the offer;
successful replacement ⇒ `used`, second attempt refused; refund of the original unaffected in every path;
restart + backup/restore persistence. Browser desktop + 390 px: full replacement through the sandbox bank, dismiss,
no-slots and inactive states.

## Delivery risk (reported early)
Estimate: A ≈ 3 h, B ≈ 6–7 h including tests, plus rebuild, browser verification and review. Earliest candidate
Sunday night; Monday morning freeze is at risk. Mitigation: A first (smaller, independently reviewable), then B;
A0 stays the rollback artifact; if B is not review-approved in time, the demo runs without B rather than with an
unreviewed B. No gate is weakened to meet the date.
