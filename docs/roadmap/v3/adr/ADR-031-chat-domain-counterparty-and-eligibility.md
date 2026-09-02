# ADR-031: The Chat Domain — Immutable Counterparty, Proven Eligibility, and a Bounded Send Window

**Status:** Accepted — implemented in V3.2-B to the externally-independent backend milestone.
**Date:** 2026-08-30.
**Relates to:** ADR-011 (no domain imports another), ADR-023 (business/seller domain and party resolution), ADR-018 (cross-domain consistency), ADR-024 (waitlist concurrency — the same conditional-write discipline), ADR-027 (subject-data contract), ADR-029 and ADR-030 (the AI domain, which this one is deliberately walled off from), `V3_SECURITY_MODEL.md` §§3–4.
**Binding on:** `V32-DEC-010`, `V32-DEC-011`, `V32-DEC-012`, closed by the product owner on 2026-08-30.
**Companion:** ADR-032 (chat privacy, abuse, and the moderation boundary). This ADR decides *who may talk to whom, and for how long*; that one decides *what happens when it goes wrong*.
**Does not decide:** attachments, push delivery, realtime transport, group conversations, or any staff-role question beyond the narrow inbox rule below. All are out of this milestone and named in "What is still open".

## Context

V2 shipped internal chat with **no eligibility rule at all**. `start_or_get` rejected exactly two things — a conversation with yourself, and a non-positive id. Any logged-in holder of `bc_send_message` could open a thread against any user id in the platform. That is a harassment surface and a user-enumeration oracle in one function, and `V3.2_PHASE_0_DISCOVERY.md` §4.1 records it as the single most important piece of V2 chat evidence.

So the question this ADR answers is not "how do we model a conversation" — that part is easy and V2 got it broadly right. It is: **what proves that two people are entitled to talk to each other, and what stops that proof from quietly changing afterwards?**

Two facts from the repository shape the answer, and neither is visible in the roadmap prose:

- **A booking has no business.** `booking.bookings` carries `customer_id` and `professional_id` and no `business_id`. The customer↔business pairing therefore has no directly stored relationship to gate on.
- **The platform already computes a seller party, twice, in two different senses.** `SellerPartyLookup.forProfessional()` returns the *current* party — business if an active `business_staff` row exists, else the professional. `commerce.orders.seller_party_type/seller_party_id` records the party *as it was at checkout*, alongside `source_type='booking'` and `source_id`.

Those two are not interchangeable, and choosing between them is the whole of §1.

## Decision

### 1. The counterparty is the historical order snapshot, and nothing else

A conversation's counterparty is resolved **exclusively** from `commerce.orders` where `source_type = 'booking'` and `source_id` is a qualifying booking, taking `seller_party_type` and `seller_party_id` verbatim. It is written onto the conversation row at creation and **never recomputed**.

**There is no fallback to current affiliation.** A qualifying booking with no order, or an order with no seller snapshot, **fails closed** — no conversation, and the same refusal a missing resource produces.

Three reasons, in descending order of importance:

**A fallback would reintroduce the mutability the snapshot exists to remove.** The point of deriving from history is that a professional moving between salons cannot move a customer's existing conversation to a business that customer never dealt with. A fallback to `business_staff` says: *unless we happen to be missing a row, in which case current affiliation decides*. That is the mutable rule wearing an exception's clothing, and it fires exactly when the data is least trustworthy.

**The snapshot is always present on the real path.** `CheckoutService` creates the booking and the order in **one transaction** — its own docblock says so, and the reasoning is that a booking without its order is a customer who owes nothing for an appointment they hold. So "no order" does not describe a legitimate booking; it describes corrupted or hand-written data. Failing closed on it is correct.

**Failing closed is cheap here and expensive to reverse.** The cost of a false refusal is one conversation that cannot start, visible immediately and fixable. The cost of a false permission is a private conversation delivered to the wrong business, discovered later or never.

### 2. A business conversation belongs to the business; access is owner and active managers

The counterparty column stores a **business id**, never a staff user id. Nothing about the practitioner reaches the customer's screen.

Access on the business side is evaluated per request as: *is the caller the business owner, or an `active` `business_staff` row with role `manager`?* Ordinary `staff` get nothing — **including the practitioner who actually delivered the service**, when their role is only `staff`.

That last clause is the uncomfortable one and it is deliberate. `business_staff.role` is `manager | staff` and nothing finer. Treating every `staff` row as an inbox grant would hand a private customer conversation to everyone a salon has ever added, and the alternative — a practitioner-specific grant — needs a role matrix that does not exist and is scheduled at V3.3-C. Between "too many people can read it" and "the right person cannot, yet", the second is the recoverable error.

**Read state is a monotonic watermark on the participant/access row**, not a per-message `read_at`. V2's per-message column is correct for exactly two participants and wrong for three, and a business-side conversation already has more than one legitimate reader on day one. This is not speculative generality; it is required by the approved scope.

### 3. Eligibility is proven from booking history, not from booking status

Qualifying statuses: `confirmed`, `completed`, `no_show` — and `cancelled` **only when `booking.booking_history` contains an event proving the booking previously reached `confirmed`**.

`pending` and `expired` never qualify.

**Why the history and not the status column.** A `cancelled` booking's current row does not say how it got there. A booking cancelled from `confirmed` is a real appointment that was called off — the parties plainly have something to discuss, often about the cancellation itself. A booking cancelled from `pending` is a **hold a stranger created and abandoned**: `pending` is the only status any authenticated user can produce unilaterally against any professional, and accepting it would re-open V2's surface through the cancellation door. The two are indistinguishable in `bookings` and completely distinguishable in `booking_history`, which is append-only and cannot be rewritten by a later status change.

**Refunds are irrelevant.** Eligibility reads `booking` and `booking_history` only. A confirmed booking later refunded stays eligible — the service relationship existed, and a refund is frequently what people need to talk about. This keeps `chat` from growing a second opinion about what a payment means.

### 4. Read stays open; sending closes 90 days after the last qualifying booking

Read access persists until retention or erasure removes the content. Sending closes **90 days** after `MAX(booking.slot_end)` across qualifying bookings with that immutable counterparty, in absolute UTC instant arithmetic.

**`slot_end`, not `completed_at`.** `completed_at` is null for `cancelled` and `no_show`, which both qualify — measuring from it would leave those two with an undefined window. `slot_end` is populated on every booking at creation and is denormalized precisely so it survives slot reshaping.

**No calendar boundary.** Unlike the AI daily quota, which is a promise about a person's calendar day and is therefore bucketed in `Asia/Tehran`, this is a duration between two instants. A timezone here would add a discontinuity nobody benefits from.

**Recomputed per send, never cached.** The authorization result does not live on the conversation row. A conversation existing is not evidence that sending is permitted, and the moment it becomes such evidence is the moment the window stops meaning anything.

A newer or future qualifying booking reopens sending by moving the maximum. There is no reactivation path and no state to get stuck in.

## Alternatives considered

**Deriving the counterparty from current `business_staff` affiliation.** Rejected in §1. It is the obvious implementation and it silently moves conversations when people change jobs.

**Deriving from the historical order where present, falling back to current affiliation.** This was engineering's own recommendation in the decision packet and the owner rejected it. The rejection is correct and the reasoning is in §1: an exception that fires on missing data is a rule that fires when the data is least trustworthy.

**A conversation per booking.** Rejected. Ten appointments with one salon would scatter a single relationship across ten threads, and the customer's mental model is the salon, not the appointment.

**Accepting any `cancelled` booking.** Also engineering's own recommendation, also rejected by the owner, and also correctly: it was a hole large enough to drive V2's entire defect through.

**Both read and send expiring.** Rejected. Looking up what a professional said about aftercare a year later is legitimate, and destroying that record serves nobody.

## Consequences

**A professional changing salon changes nothing about existing conversations.** They stay with the business that was actually paid. New bookings under a new affiliation produce a new counterparty and therefore a new conversation, which is the honest outcome.

**Some legitimate conversations will be refused.** A booking predating this feature with no order row cannot start a conversation. That is the fail-closed cost, and it is visible and reportable rather than silent.

**A practitioner at a salon may not be able to read a conversation about their own client.** Named in §2 as a deliberate, temporary consequence of the missing role matrix.

**Eligibility is a query, not a stored flag**, evaluated inside the send transaction. That costs a join per send and buys the property that a stale row can never authorize anything.

## What is still open

- **The V3.3-C staff role matrix**, which owns any broader or practitioner-specific inbox permission. Nothing here forecloses it.
- **Attachments, push, and realtime transport** — out of this milestone entirely (ADR-032 and the dependency ledger).
- **Approved legal and disclosure copy** — a public-release gate, and explicitly *not* a gate on this backend milestone, because `V32-DEC-013` chose the ADR-027-consistent erasure model and therefore introduces no new promise needing new wording.
