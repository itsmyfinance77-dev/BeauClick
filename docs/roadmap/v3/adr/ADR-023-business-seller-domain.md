# ADR-023: Business as an Independent Seller Party, Not a Layer Under Professional

**Status:** Accepted — implemented in Phase 4.
**Date:** 2026-08-22.
**Relates to:** ADR-011 (repository architecture / module boundaries), ADR-017 (financial isolation).
**Closes:** the "Business seller party" item Phase 3 explicitly left as `LATER`; GAP-13 (flat staff model), partially.

**Amended 2026-09-04 (`V33-DEC-021`):** one sentence in *"`owner` is not a
`business_staff` role"* below said V3 never grants the identity-level
`professional`/`business` roles dynamically. That was an accurate description of
V3 at the time and became a defect once Story #69 shipped a route that enforces
a capability only those roles carry (#75). The owner ratified `V33-DEC-021` on
this date: the roles are now granted atomically on OWNERSHIP CREATION. The
sentence is annotated in place and superseded **only to that extent** — the
financial-party model, the structural consent rule, the one-active-affiliation
invariant and every consequence recorded here stand unchanged, and
`business_staff` still grants no `business` role.

## Context

Phase 1 scoped Business entities out entirely, recording the open question honestly: "Business (a structurally similar but distinct V2 CPT, not one-owner-per-profile once staff exist) is deliberately out of this phase." Phase 2 and 3 both built financial-service and commerce's order model already *typed* `sellerPartyType: 'professional' | 'business'` and `FinancialParty.partyType` the same way — the shape was anticipated, but every real code path hardcoded `'professional'`.

Two designs were available for what a "Business" actually is:

1. **A second, independent provider type** — its own service catalogue, its own availability/booking flow, parallel to Professional.
2. **An organizational/financial wrapper around existing Professional profiles** — a business doesn't deliver services itself; the professionals who are its staff do, exactly as they already do today.

Booking-service, search-service, and the entire availability/slot-claim concurrency guarantee (the three-layer protection `BookingService.claimSlot()` documents) are built **entirely** around `professionalId`. Option 1 would mean touching that code's core identity concept — the single highest-risk surface in the whole platform — for a phase whose remit already includes a new concurrency-sensitive domain (waitlist) and a new cross-schema financial consumer.

## Decision

**Business is an independent seller party (option 2), never a booking/availability participant.**

- `business.businesses` and `business.business_staff` are new tables, in a new schema, owned by a new `services/business` domain. Neither `provider.professionals`, `booking.availability_slots`, nor `booking.bookings` gained a column, an index, or a migration.
- A `BusinessStaffEntity` row links an identity user (`userId`, required) to a business, with an **optional** `professionalId` — set only when that staff member also personally delivers services through their own, completely unchanged professional profile.
- The one thing that changes when a professional becomes an active staff member of a business: **who the money is for.** `SellerPartyLookup` (composition root) is the single place that answers "who is the real seller for this professional's work" — consulted by both `ServiceCatalog` (order creation) and `FinancialPartyResolver` (session-scoped financial reads), so the two can never disagree about the same professional.

```
customer books professional X's service
        |
        v
ServiceCatalog.findServiceOffering() -- asks SellerPartyLookup.forProfessional(X)
        |
        +-- X has an ACTIVE business_staff row --> sellerParty = { business, businessId }
        +-- otherwise                            --> sellerParty = { professional, X }
        |
        v
order.sellerPartyType / sellerPartyId -- copied verbatim into LedgerService.recordPayment()
```

### Consent is structural, not a policy note

A `business_staff` row always starts `invited`, created by someone who is **not** the invitee. Only `StaffService.accept()`, called from the invited user's own authenticated session, can move it to `active`. There is no code path — not even the business owner's own session — that can move a row to `active` on someone else's behalf. This matters specifically because "active" is what redirects a professional's real earnings: without structural consent, an owner could invite an arbitrary professional id and silently begin receiving their money.

### At most one active affiliation per professional

`uq_business_staff_active_professional`, a partial unique index on `(professional_id) WHERE status = 'active'`, makes "which business does this professional's money belong to" a lookup, never a policy decision with an edge case. A professional who wants to change or leave a business is deactivated first — there is no state where the answer is ambiguous.

### `owner` is not a `business_staff` role

The owner is `BusinessEntity.ownerId` — a raw identity id, exactly `ProfessionalEntity.ownerId`'s own pattern (self-service creation, ownership-gated, no dynamic identity-role grant required; V3 never populates `identity.users.roles` dynamically for `professional` either — see the account-resolver's `roles: ['customer']`-only reality). An owner is never a row that could be edited, removed, or raced against by the authorization code that governs everyone else.

**Amended 2026-09-04 (`V33-DEC-021`) — the parenthesis above is superseded, the
sentence around it is not.** "No dynamic identity-role grant required" described
V3 accurately until Story #69 enforced `bc_manage_own_subscription`, a capability
carried only by the `professional` and `business` roles. Account creation grants
only `customer`, so a genuine seller was refused `403` on every subscription
mutation — an active API-path defect, recorded as #75.

Four statements now hold together, and the distinction between the first two is
the one this ADR was already drawing:

- **beneficiary resolution may follow affiliation.** §3 above is unchanged: an
  affiliated professional's earnings belong to the business. That is
  attribution, and it answers *whose money is this?*
- **seller workspace authorization follows ownership.** It answers *who may act
  on this workspace?* — a different question, settled by `V33-DEC-020` for
  finance and by `V33-DEC-021` here.
- **owner role assignment follows ownership creation.** `ProviderService.create`
  and `BusinessService.create` grant the matching role atomically, in their own
  existing transaction, through a composition-root port. Verification is not the
  trigger; a caller-supplied field never is.
- **`business_staff` never grants a `business` role.** Manager and staff alike.
  The owner is still `BusinessEntity.ownerId` and still never a row in that
  table, which is exactly what makes the ownership predicate a lookup rather
  than a policy decision.

What does **not** change: the role is never sufficient authorization. Every
seller route keeps authentication, its declared capability, live ownership and
any lifecycle predicate it already had. A role held without ownership resolves
no party and reaches nothing.

## Consequences

- **Positive:** zero risk to booking/availability's existing, hard-won concurrency guarantees. The riskiest code in the platform was not touched.
- **Positive:** `MyFinanceService` — already built to take only a session user id and resolve its own party (the GAP-05 fix) — needed **no changes at all** to correctly aggregate a business's settlement across every affiliated professional. The abstraction Phase 2 built for a different reason paid for this feature for free.
- **Negative, disclosed:** a business cannot (yet) have its own service catalogue independent of a staff professional's — every bookable service still belongs to exactly one professional's calendar. A pure "business offers service X, any available staff member delivers it" model is out of scope; this is the direct consequence of not touching booking's core identity concept, not an oversight.
- **Negative, disclosed:** business-scoped mutation of a staff professional's bookings/services/availability (an owner managing a staff member's calendar directly) is explicitly out of Phase 4 scope. An owner sees aggregated settlement and the staff roster; managing a specific professional's bookings still requires that professional's own session. See V3_PHASE4_IMPLEMENTATION.md §3 for the full scope-discipline reasoning.

## What was deliberately not built

- **Invite-by-email/lookup.** `InviteStaffDto.userId` requires the owner to already know the invitee's identity user id. A directory/lookup flow is real product work with its own privacy questions (can any authenticated user search for any other by phone/email?) that this phase did not scope.
- **A business-scoped capability system reusing `CAPABILITIES_BY_ROLE`.** Business authorization is entirely local to `services/business` (owner/manager/staff resolved from `business_staff`, not from the identity-level role/capability map), matching how professional-service's ownership-based authorization already works independent of that map.
  *Amended 2026-09-04 (`V33-DEC-021`): still true, and now load-bearing.* #75
  adds a GLOBAL role for the business OWNER and touches none of this
  intra-business model. The two systems stay disjoint, and business-scoped staff
  roles and permissions remain Story #44's territory.
