# 42 — Seller and salon: subscription, credits, collection policy, operations, funds

**Prototype:** `Prototype - Pro and Admin.dc.html` §20–§24
**Baseline:** `6695234eded1` (revised 2026-09-12)
**Stories merged:** #56a, #69, #58a, #40c-1 (#57), #104, #44a, #44b, #44c, #110a, #127b, #72, **#115, #95, #141**.
**Still blocked:** #99 (external), #43 (external), #47 (external), #42 (legal), #44e (not built).

## 1. Subscriptions are a collection, never a singular resource (§20)

One user may own a professional **and** a business; both `owner_id` indexes are independent. A
singular `/me/subscription` has no answer that is not a silent choice, and `V33-DEC-018` forbids
every way of making one. The design shows every owned workspace with its own opaque
`workspaceRef` and never pre-selects one.

Reads require session + live ownership. Writes additionally require `bc_manage_own_subscription`,
which is **not privileged** — so there is no live re-check and a revoked grant takes effect at the
next token issue, up to the access-token TTL later. The design states that instead of claiming a
revocation guarantee the capability does not carry.

The D-7 card shows four real zeros from the migration: price, included credits, staff seats,
included locations. Zero is **absence of entitlement**, never unlimited, and never a hidden code
default. No plan price, allowance, seat count, location count, capability bundle or billing term is
invented anywhere.

## 2. Credits (§21)

Balance is derived — grants − consumptions + returns — never a stored counter. One unit consumed at
first `confirmed`, keyed uniquely by booking id; `pending` and `expired` consume nothing; oldest
grant allocated first under a per-party advisory lock. Reschedule transfers. Provider/platform
cancellation returns exactly once as a separate immutable idempotent row.

Purchase **ships safely unavailable and that is not a defect**: the subscription is bound to no
booking-credit schedule key, because no such schedule has been published. The mechanism is complete
and dormant until an administrator creates the schedule, publishes a version, and publishes a plan
version carrying its key. The purchase button is disabled with that exact reason.

The purchase records an immutable purchase and its price snapshot and **writes no grant** — the
grant happens in the same transaction that records a verified payment, and no gateway adapter exists
in the repository (#99). 80%/100% notification thresholds exist as structure with no approved value.

## 3. Collection policy assignment (§22)

The seller-readable catalogue exposes **only** `policyKey` and `displayName`. Assignment is
seller-party-level, binds a stable key (not a version), supersedes immutably, is idempotent when
re-submitted, has no un-enrollment path, and collapses every failure to one non-enumerating refusal.
**Revised 2026-09-12:** #115 is merged, so an assignment now governs every order created after it — resolved at the database clock instant inside the order transaction and snapshotted immutably. Orders created before it are untouched. The screen states that, not the previous "governs no booking" caveat. Per-service override is deferred: a service is owned by a professional while the booking is
sold by the business, and no precedence rule repairs that ownership mismatch.

## 4. Salon operations (§23)

Locations (6 routes), resources (4), service resource requirement (2), classification (2), staff and
grants. **Every handler is owner-only** via a per-handler ownership resolver — a class-level
decorator would be silently ignored. An active manager, an ordinary staff member, a stranger and a
foreign owner all receive the same refusal a nonexistent business receives.

`retired` on a resource is terminal: no restore route exists here because none exists in the server
and PostgreSQL refuses the transition. The scoped-staff vocabulary is exactly
`['practitioner_chat']`. The six personas with no authority are listed explicitly as declared and
unauthorized — **with no disabled buttons**, because a disabled button is an implicit promise.

## 4-a. Governance state is a real fact the seller cannot read

#95 writes a monotonic per-party governance row (`legacy_exempt | governed`). **No seller-facing route exposes it**, so the badge on the plan card is designed against a real backend fact with no read contract behind it. Surfacing it needs either a new field on the subscription view or an explicit decision to keep it operator-only.

## 5. Funds and settlement (§24)

Implemented reads: workspace list, summary, outstanding orders, settlements (keyset-paged,
workspace-bound cursor), per-order ledger. The six amount families — pending, available, held,
disputed, refunded, settled — are rendered as **states with no figures**, because the pending-funds
model does not exist and only its invariants are ratified.

**No commission rate, percentage or amount appears anywhere on this surface**, and no amount is
described as the seller's earnings or platform revenue. Contradiction C-5 (the live 1500 bp constant
versus the ratified fail-closed rule) is reported in `V3.3_BASELINE_AUDIT.md` and assigned to #43;
this design does not work around it.

The venue balance is shown as a seller-reported fact, separate from collected money, and never as an
asset, liability or revenue.
