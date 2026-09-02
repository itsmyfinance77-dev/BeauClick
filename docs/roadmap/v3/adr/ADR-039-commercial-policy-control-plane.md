# ADR-039 — Commercial policy is a versioned control plane, not Booking or Payment logic

**Status:** ACCEPTED — 2026-09-01  
**Approver:** product owner  
**Backlog:** #38, #39  
**Depends on:** ADR-018 (same-cluster consistency), ADR-023 (business seller party), ADR-025 (financial outbox), ADR-028 (honest readiness)

## Context

The product owner approved one redesign made of three inseparable directions:

1. customer discovery and booking stay free while seller subscriptions, optional
   marketplace acquisition, paid add-ons, retail and B2B form a flexible revenue
   stack;
2. cancellation, late cancellation, no-show, reschedule, provider fault and
   disputes become versioned policy outcomes instead of hard-coded payment
   branches;
3. a booking may be paid at the venue, paid in full online, or confirmed with an
   online deposit while the balance is paid directly to the seller.

The existing code has the right domain seams and the wrong commercial
assumption for this scope. `booking` owns a professional-keyed state machine and
emits facts. `commerce` creates one order whose `total_toman` is the amount the
current checkout collects. `payment` verifies that exact amount. A
`BookingCancelled` consumer refunds the entire remaining collected amount.
`no_show` is a terminal booking fact with no financial consequence. The default
commission is 1,500 basis points. There is no seller subscription, payment
schedule, deposit allocation, dispute hold, or seller-pending balance.

Putting the new rules into any one of those existing domains would make future
policy changes cross every domain again. Putting them behind feature flags only
would be worse: dormant code is still executable code, and a flag does not
version the terms a customer accepted.

## Decision

### 1. Add a `commercial-policy` domain

`services/commercial-policy` owns policy registration, validation, version
resolution and evaluation. Its browser-safe vocabulary lives in the
zero-dependency `@beauclick/commercial-policy-contract` package.

The domain owns no booking, order, payment or ledger row. Later composition-root
adapters hand it authoritative facts through narrow ports. No existing domain
imports the policy implementation. The composition root coordinates the
workflow, as ADR-018 already requires for cross-domain transactions in the same
PostgreSQL cluster.

### 2. Keep four controls structurally separate

| Control | Question it answers | Example |
|---|---|---|
| rollout flag | May this code path be reached in this deployment/cohort? | deposit sandbox enabled |
| plan entitlement | Has this subscriber bought access? | `deposit_collection` |
| business policy | Which platform-approved terms apply? | 20% deposit, 24h cutoff |
| kill switch | Must an otherwise-valid money action stop now? | settlement release disabled |

No one control implies another. In particular, a UI flag is never authorization,
an entitlement is never a policy value, and a policy cannot bypass a kill switch.

### 3. Collection mode is closed and explicit

The first contract version recognises exactly:

- `pay_at_venue` — BeauClick collects no service money;
- `deposit_online_balance_at_venue` — BeauClick collects the snapshotted deposit
  and the seller collects the disclosed balance outside BeauClick;
- `full_payment_online` — BeauClick collects the full service price.

The full service price, the amount collectible by BeauClick and the venue balance
are different facts. A client must never infer one from another. Deposit is an
allocation of the price, not a discount or fee.

Percentage deposits use integer basis points. The v1 calculation rounds down to
the nearest toman, then applies the snapshotted minimum and maximum and finally
caps collection at the full service price. This is a safety invariant rather
than a configurable business preference: BeauClick must never collect more than
the disclosed service total, and the platform-collected amount plus the venue
balance must equal that total exactly.

### 4. Policies are immutable versions; bookings receive snapshots

A policy definition is immutable once a booking references it. A booking-facing
snapshot carries the exact numeric terms, currency unit, copy version and policy
version accepted at confirmation. Editing a business policy creates a new
version; it never changes historical cancellation or settlement consequences.

The foundation contract contains no seller or customer identifier. Ownership is
resolved from the authenticated session and authoritative seller-party history
by later domain adapters.

### 5. Booking stays professional-keyed

`booking.bookings.professional_id` remains the fulfilment resource. A salon,
clinic or maison is the commercial workspace, seller party, subscription owner,
location/resource coordinator and permission scope. This programme does not
replace `professional_id` with a generic party id.

That preserves the proven slot-claim concurrency model. Aggregate calendars,
business service templates and resource allocation are additive later stories.

### 6. Identity, workspace role and vertical are different axes

One identity may be a customer, own a solo professional profile and participate
in multiple business workspaces. A salon manager, practitioner, receptionist,
finance operator and B2B seller are scoped memberships/capabilities, not global
identity types. Salon, laser/beauty clinic, maison, retail, wholesale, academy,
mobile team and multi-location organisation are business verticals, not roles.

### 7. Production money movement is unavailable by construction

This foundation registers vocabulary and policy definitions only. It has no
payment, refund, payout or settlement port and is not composed into the API.
Later code must separately pass rollout, entitlement, policy and kill-switch
checks. Real deposit collection and seller settlement remain blocked by #46 and
#47. A deterministic sandbox is not evidence of a production provider.

### 8. Build extension points, not every speculative branch

The contract reserves no enum member for an unimplemented promise. A new policy
outcome is an additive contract version and an explicit story. We design the
control plane for change, implement only approved variants, and delete expired
flags after rollout. Disabled code receives the same tests and security review
as enabled code; therefore unused variants are not built merely because they
could be hidden.

## Consequences

- Revenue and payment policy can evolve without changing Booking's state
  machine or teaching Payment why money moves.
- Later stories add persistence and ports without changing the v1 vocabulary.
- Subscription is separate from customer Loyalty membership.
- Venue-collected money is always labelled seller-reported and is never included
  in platform-collected totals without external evidence.
- The existing full-payment flow remains untouched until a later migration and
  compatibility story proves the transition.
- More explicit state exists, but it is localised and testable instead of being
  spread across event handlers.

## Rejected alternatives

### Put deposit rules in Booking

Rejected. Booking owns time, capacity and lifecycle facts. It must not know a
gateway, commission, refund or seller balance exists.

### Put cancellation policy in Payment

Rejected. Payment executes an authorised amount. It must not decide whether a
customer was late, a provider was at fault, or a dispute is open.

### Treat deposit as a pricing adjustment

Rejected. A deposit does not change service price. Modelling it as a fee or
discount corrupts receipts, commission and refunds.

### Build every possible policy and hide it behind flags

Rejected. Flags do not remove maintenance, security, migration or test cost and
do not preserve historical accepted terms.

### Make Business the booking participant

Rejected. It would replace the proven professional/slot model and widen the
blast radius into search, chat, reviews, waitlist and financial attribution.

## Open gates

- #46: numeric plan, deposit, cutoff, retention, dispute, commission and copy
  parameters require product-owner and legal closure.
- #47: production partial collection, marketplace settlement, reconciliation,
  refund and banking capability require a named provider and verified contract.
- Medical/clinical data remains out of scope pending a separate privacy and
  legal decision.

## Owner ratification note — 2026-09-02

*Appended after acceptance. The decision text above is unchanged and is not
retrospectively widened; this note records what the owner later ratified on top
of it.*

On 2026-09-02 the product owner ratified the **structure** of `V33-DEC-009`
(plan catalogue and booking-credit pricing) and `V33-DEC-010` (consumption,
return and overage). Those details were **not** part of this ADR's original
decision. The binding wording lives in
[`V3.3_DECISION_REGISTER.md`](../../v3.3/V3.3_DECISION_REGISTER.md).

Three points bear directly on this ADR's own text:

1. **Section 3's collection modes are refined, not changed.** Free customer
   booking (`V33-DEC-001`) means the customer pays no separate BeauClick booking
   fee. It does not mean the service price is zero. `pay_at_venue` may carry a
   non-zero full service price with a zero platform-collectible amount, so a
   confirmation path predicated on a zero order total is not an acceptable
   reading of this ADR. That capability belongs to #41.
2. **Section 7's "unavailable by construction" is narrower than #47.** #47
   blocks real paid subscription/top-up collection and settlement. It does not
   block the plan catalogue, immutable plan versions, a zero-price base
   workspace, entitlement grants, sandbox consumption and return, or PostgreSQL
   concurrency tests. Those may proceed with production paid behaviour disabled.
3. **A new privileged capability is added to the control plane's authorization
   surface.** `bc_manage_commercial_plans` gates administrator plan and
   price-schedule mutations, joins `PRIVILEGED_CAPABILITIES`, receives
   live-revocation rechecking, and requires an audited mutation with a mandatory
   reason. Seller credit accounting remains an entitlement ledger in the shared
   application cluster, not a money ledger in the Financial DataSource.

The `#38` backlog effect is recorded in
[`BACKLOG_INDEX.md`](../../../product/BACKLOG_INDEX.md): Story #40 is decomposed
into #40, #56, #57 and #58.
