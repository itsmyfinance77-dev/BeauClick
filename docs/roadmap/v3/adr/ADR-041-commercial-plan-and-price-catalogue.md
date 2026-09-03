# ADR-041 — The seller plan and booking-credit price catalogue is an immutable, administrator-versioned entitlement record

**Status:** ACCEPTED — 2026-09-02
**Approver:** product owner (structure of `V33-DEC-009` ratified 2026-09-02)
**Backlog:** #40 (`#40a`)
**Depends on:** ADR-039 (commercial policy is a versioned control plane), ADR-027
(subject-data contract), ADR-018 (same-cluster consistency), ADR-017 (financial
isolation), ADR-011 (module boundaries)
**Constrains:** #56 (`#56a`), #69 (`#56b`), #57 (`#40c`), #58 (`#40d`)

**Amended 2026-09-03:** §6 said `#40b` "must not ship before #46 closes the
base-workspace definition". The owner ratified **`V33-DEC-018`** on that date,
splitting `#40b` into #56 (`#56a`) and #69 (`#56b`) and approving both with #46
still open. §6 below records the supersession and what survives it. Nothing else
in this ADR changes, and no catalogue behaviour is affected.

## Context

ADR-039 established that commercial terms are versioned control-plane data
rather than logic inside Booking, Commerce or Payment, and that a booking
receives a **snapshot** of the terms it accepted. It stopped short of any
persistence: Story #39 shipped a browser-safe contract, an in-memory registry
keyed by exact `key@version`, and a four-control gate. Nothing was stored,
nothing was administrable, and the module was not composed into the API.

On 2026-09-02 the product owner ratified the **structure** of `V33-DEC-009`
(plan catalogue and booking-credit pricing) and `V33-DEC-010` (consumption,
return and overage), and Story #40 was decomposed into four
(#40 `#40a`, #56 `#40b`, #57 `#40c`, #58 `#40d`). The same review recorded that
#47 blocks real paid collection and settlement and does **not** block the plan
catalogue, immutable plan versions, a zero-price base workspace, entitlement
grants, sandbox consumption and return, or PostgreSQL concurrency tests.

This ADR decides how the catalogue itself is modelled. It is written before the
migration and before the implementation, because the whole value of the thing is
a property of its schema: terms that cannot be rewritten after a seller has
bought against them.

Every commercial **value** — price, included allowance, seats, locations,
capability bundle, billing term, minimum and maximum custom quantity, tier
boundaries, presets, expiry, carry-forward, grace quantity, refundability, tax
and revenue recognition — remains open under #46 and is **not** decided here.

## Decision

### 1. Module ownership and boundary

`services/commercial-policy` owns the catalogue. It gains a second, additive
surface — `CommercialCatalogueModule` — alongside Story #39's registry and
control gate, which are untouched.

Physical tables live in a new `commercial` PostgreSQL schema on the **shared
application cluster**, owned by the ordinary application role. They are
deliberately **not** on the separate Financial DataSource (ADR-017). §11 argues
why.

The Nx tag `scope:commercial-policy` already permits dependencies on
`scope:shared` only, so the catalogue may use `@beauclick/auth`,
`@beauclick/audit`, `@beauclick/subject-data`, `@beauclick/http` and
`@beauclick/money`, and may not import any other domain. Lint enforces it; this
ADR does not restate a rule a reviewer would have to remember.

The composition root (`apps/api/src/composition`) registers the module, its
entities and its subject-data contract, exactly as it does for every other
domain. That composition is a narrowing of ADR-039 §7, not a contradiction of
it: §7's "not composed into the API" described the state Story #39 left behind,
and ADR-039's own 2026-09-02 ratification note records that the catalogue may
proceed with production paid behaviour disabled. The module still declares **no
payment, refund, payout or settlement port**, and this story adds none.

### 2. Two independently versioned aggregates

A **plan version** answers *what a subscriber is entitled to*. A **price
schedule version** answers *what a quantity costs*. They version independently
because they change for different reasons and at different rates: a plan's
included capabilities may stand for a year while its price is repriced, and a
booking-credit tier table is repriced without any plan changing at all.

```
commercial.plans                    stable plan key
  └── commercial.plan_versions      immutable terms + lifecycle + activation window
        └── (references) ───────────┐
commercial.price_schedules          stable schedule key + purpose
  └── commercial.price_schedule_versions  immutable currency/bounds/window
        └── commercial.price_tiers        immutable quantity → unit price
```

A plan version references exactly one **published** price schedule version. That
is the plan's own recurring price, and per `V33-DEC-009` a flat price is
represented as a one-tier schedule rather than as a scalar column — so there is
exactly one pricing mechanism in the platform and no second, simpler one that
later has to grow tiers.

### 3. Lifecycle: `draft -> published -> retired`, and nothing else

Three states, one direction, no return.

| From | To | Meaning |
|---|---|---|
| `draft` | `published` | The terms become selectable inside their activation window. |
| `published` | `retired` | New selection and purchase stop. Nothing already granted changes. |
| `draft` | *(deleted)* | A draft may be discarded outright. Nothing referenced it. |

Every other transition is refused **by the database**, as an explicit allow-list
in a `BEFORE UPDATE` trigger rather than as a list of refusals — so a fourth
state added later is refused by default instead of being silently permitted from
and to everywhere. This is the shape `referral.referrals` already uses and the
reason that migration records.

A `published` or `retired` row cannot be deleted either. The `BEFORE DELETE`
trigger permits `draft` only.

### 4. Which draft fields may change, and what freezes at publication

**In `draft`, every term is editable.** That is what a draft is for, and Issue
#40 asks for it explicitly. Editing a draft is still an audited administrator
mutation with a mandatory reason.

**Frozen always, in every state**, because they are the row's identity:
`plan_key` / `schedule_key`, `version`, `created_at`, and the creation actor
columns.

**Frozen at publication**, permanently: every term, every quantity, every price,
the currency, and the activation window. After `lifecycle_state` leaves
`draft`, the only columns a trigger will accept a change to are the lifecycle
columns themselves — `lifecycle_state`, `published_at`, `published_by_user_id`,
`published_by_label`, `retired_at`, `retired_by_user_id`, `retired_by_label` —
and each only along the allow-listed transition that sets it.

Price tiers are a child table, which would otherwise be a hole in that
guarantee: freezing the parent row does nothing about an `INSERT` into its
children. A `BEFORE INSERT OR UPDATE OR DELETE` trigger on `commercial.price_tiers`
therefore refuses any write whose parent schedule version is not `draft`. The
tier set is as immutable as the row that owns it.

**Restoring earlier terms is a new version, never an edit or a reactivation.**
There is no code path, route, or SQL grant that could do otherwise.

### 5. Activation windows and database-enforced non-overlap

A version carries `activation_starts_at` (required) and `activation_ends_at`
(nullable, meaning open-ended). The window is half-open, `[start, end)`.

Two versions of the same plan key must never both be active. That is enforced by
a PostgreSQL **exclusion constraint** over `(plan_key WITH =, tstzrange(...) WITH &&)`,
partial on `lifecycle_state <> 'draft'`, and by the identical constraint on
schedule versions. The same shape `booking.availability_slots` uses for slot
overlap, and for the same reason: an application-level check under READ
COMMITTED lets two concurrent inserts each observe a free window and both
proceed. That is `GAP-04` in miniature, and it is exactly the class of bug that
only a real-PostgreSQL suite can prove closed.

Drafts are excluded from the constraint deliberately. A draft is not selectable,
so it occupies no timeline; two competing drafts for the same period are a
normal administrative state, and the constraint decides between them at the
moment one of them is published.

**Retirement does not close the window.** `retired_at` is a separate lifecycle
fact, and `activation_ends_at` stays exactly as published. Selectability is
`lifecycle_state = 'published'` **and** the instant falls inside the window —
two conditions, both live, neither rewriting the other. Editing the window at
retirement would have been a mutation of a frozen field to express a fact the
row can already carry, and it would have made the historical record of what was
offered, and when, unreadable.

### 6. The base workspace is a row, never a code path

`V33-DEC-009` ratifies `D-7` as an automatically assigned, published, zero-price
plan version, so that every seller has one **explicit** subscription history
rather than an implicit fallback.

The mechanism is a column, not a constant. `commercial.plan_versions.auto_assignable`
is an ordinary administrator-controlled boolean, and a second exclusion
constraint guarantees that **at most one** auto-assignable version is active at
any instant, platform-wide. Later stories ask the catalogue *"which version is
auto-assignable at this instant?"* and receive a row or a refusal. They never
ask for `D-7`.

The string `D-7` therefore appears in exactly three places: this ADR, the
migration that seeds the row, and the tests that assert the seeded row's
structural properties. **No production code names it.** That is the whole
difference between a base workspace and a hidden fallback, and it is asserted by
test rather than left as an intention.

Two further guarantees attach to the flag:

- an auto-assignable version's price schedule version must be a **single tier
  priced at zero**, checked by the publication trigger, so the base workspace
  cannot silently become paid;
- assignment itself — creating a subscription row for a seller — is **#40b** and
  is not implemented here. This story creates the record that assignment will
  later point at, and nothing that performs it.

**What `D-7` is seeded with, and why.** `V33-DEC-009` fixes only that it is
published and zero-price. Its included credits, staff seats, locations and
capability set are values still open under #46. It is seeded with **zero for
every quantitative entitlement and an empty capability set** — the only values
that confer nothing and therefore invent nothing. Zero is the absence of an
allowance, not a choice of one. Nothing in this story reads those numbers: the
first consumer is #40b. When #46 does close it, the administrator publishes a
**new** `D-7` version. The model forbids editing this one, which is the point.

**Amended 2026-09-03 (`V33-DEC-018`).** This paragraph originally added that
#40b "must not ship before #46 closes the base-workspace definition". The owner
superseded that constraint when approving the `#56a`/`#56b` split. The reasoning
is narrowed rather than dismissed: nothing consumes booking credits until #58, so
a base workspace conferring zero entitlements changes no seller's capabilities,
and `V33-DEC-018` requires the zero-quantity grant to be **written** so the
activation is an explicit auditable fact rather than an absent row. The
consequence that does survive — sellers backfilled onto this seeded version stay
on it when #46 publishes a new one, because assignment happens once per party —
is recorded in `V33-DEC-018` and needs its own decision and migration.

### 7. Pricing: immutable tiers, exact integer arithmetic, and refusal

A schedule version owns an ordered set of tiers, each a half-open quantity range
`[min_quantity, max_quantity]` with an integer unit price. `max_quantity` may be
`NULL`, meaning unbounded above.

Three invariants, all enforced in the database:

1. **No overlap.** An exclusion constraint over `(schedule_version_id WITH =,
   quantity_range WITH &&)`, where `quantity_range` is a stored generated
   `int4range` column. Two tiers claiming quantity 100 is unwritable, not merely
   unlikely.
2. **No gaps, and full coverage.** Checked by the publication trigger against
   the version's own `min_purchase_quantity` … `max_purchase_quantity` bounds: the
   tiers must start at the minimum, be contiguous, and reach the maximum. A
   schedule with a hole cannot be published, so no resolution can ever land in
   one.
3. **At least one tier.** A flat price is a one-tier schedule; an empty schedule
   is not a free one.

Resolution is exact and integral. `unit_price_toman` is `BIGINT` integer Toman —
the platform's single money representation (`@beauclick/money`), never a float
and never a decimal string — and a total is `quantity × unit_price`, computed
with `BigInt` so the product is exact at the contract's maximum amount.

**Currency is `IRT` and the database says so.** A `CHECK (currency_code = 'IRT')`
rather than a lookup table, because `V33-DEC-009` permits exactly one currency
until an owner decision widens it, and a widening should be a migration and a
decision rather than an `INSERT`.

**An absent, unpublished, out-of-window or incomplete schedule refuses.** There
is no fallback price, no default tier, and no "nearest" match. The resolver
raises a typed refusal that names the missing configuration without disclosing
catalogue internals. This is the same discipline Story #39's registry already
applies to policy versions: asking for *latest* would let a historical purchase
silently adopt live configuration.

### 8. No allowance is a constant, a default, a fallback, or a seed

`V33-DEC-009` states it and Issue #40 requires it to be enforceable rather than
aspirational. There is no allowance in code — not `200`, not any other number —
and none in the schema as a column default, and none in the migration as a seed
beyond the zero §6 argues for.

A repository test in `services/commercial-policy` scans this module's own
sources, its contract package and its migration SQL for allowance-shaped
literals: a non-zero number reaching an identifier or column in the credit,
allowance, seat, location, quantity-bound or price vocabulary. It is deliberately
**narrow** so it can be trusted:

- comments and documentation prose are stripped before scanning, so a historical
  sentence about V2's behaviour is not a finding;
- an HTTP status is not an allowance. `200` in `toBe(200)`, `HttpStatus.OK`, or a
  status-shaped identifier is not flagged, and the spec carries that case as a
  **control** so the exclusion is proved rather than assumed;
- the detector is proved to fire on planted positives held as fixtures in the
  spec itself, because an absence assertion whose detector cannot fail is not
  evidence.

### 9. Authorization, audit and the absence of impersonation

Administrator mutations are gated on a new capability, `bc_manage_commercial_plans`,
which joins `PRIVILEGED_CAPABILITIES`. That single list confers both properties
this surface needs, and the platform already implements both:

- **live revocation re-checking** on every request, so an administrator whose
  authority has just been withdrawn loses the surface now rather than at token
  expiry;
- **`libs/audit`'s refusal to boot** when a mutation gated on it declares no
  audit action — `GAP-02`'s bug class, which V2 hit three times before it was
  made structural.

The capability is granted to `administrator` and deliberately **not** to
`platform_operator`. That tier exists precisely to be the narrower one, and
defining the commercial terms sellers are billed against is not routine platform
operation. It is the same call, for the same reason, that `bc_moderate_chat`
records.

**Every mutation writes one audit record with a mandatory reason.** The reason is
validated before the mutation is attempted, so a blank or whitespace-only reason
is refused with nothing written anywhere. The record is written through
`AdminAuditService.record` inside the **same transaction** as the domain change,
so the two commit together or not at all — a rollback leaves neither a plan
version nor an orphan audit row. No route on this surface uses
`recordDetached`; there is no physically separate DataSource to justify it.

**No impersonation.** The actor is `request.user.userId`, resolved from the
authenticated session. No route accepts an actor, owner, administrator or
subscriber identity in a body, query parameter, path segment or header, and the
adversarial suite proves a forged one is rejected rather than honoured.

This story builds **no second authorization system and no second audit system**.
It uses `CapabilityGuard`, `PRIVILEGED_CAPABILITIES`, `@RequireCapability`,
`@AuditAction` and `AdminAuditService` exactly as they are.

### 10. ADR-027 disposition: `retained`, with reasons

Every one of the five tables carries administrator identity — `created_by_user_id`,
and on versions also `published_by_user_id` and `retired_by_user_id`. All five
are therefore claimed **`retained`**, never `no_subject_data`.

The reason is the same one the administrative audit log carries, and it is a
real reason rather than a formula: these rows are the immutable record of which
administrator published the commercial terms sellers were billed against. An
erasure able to blank that attribution would let an operator launder their own
commercial history — take the action, request deletion, and the record of who
set the price goes with them. `retained` is what the rows are for.

Three consequences are stated rather than left to be discovered:

- **Identity columns use the platform's detectable `_user_id` suffix.** ADR-027's
  boot-time coverage check recognises that suffix, so the naming and the declared
  disposition agree and the check can see both. Renaming a column to evade
  coverage detection is the failure this is written to prevent, and the naming
  here is belt rather than braces: the disposition is declared explicitly and
  proved by test.
- **Nothing is exported.** A plan version is a platform commercial record, not
  personal data about the administrator who published it, and returning the
  catalogue through a subject export would disclose commercial configuration to
  anyone who asks for their own data. The contract returns no sections, for the
  same reason `admin`'s does.
- **The reported counts are truthful.** Erasure returns zero anonymized, zero
  deleted, and names all five tables as retained with their reasons. It is a real
  answer, not a stub, and the boot-time coverage assertion against the live
  `pg_tables` catalogue is what proves the claim was reached.

The seeded `D-7` rows carry a **label** rather than a user id, because there is no
administrator at migration time. That is the pairing
`admin.admin_audit_log.actor_label` already uses for the documented bootstrap,
and a `CHECK` enforces that exactly one of the two is present on every actor
pair.

### 11. This is an entitlement catalogue, not the financial ledger

The tables live on the shared application cluster and not on the Financial
DataSource, and the distinction is not a convenience.

`financial.*` is the money ledger: legally retained, append-only under a role the
application cannot connect as, unreachable from the shared pool by construction
(ADR-017). It records money that moved.

The plan catalogue records **what may be bought and what it would cost**. No row
here is a payment, a receivable, a payout or a revenue recognition. Nothing here
proves anyone paid anything, and this story moves no money at all — real
collection stays blocked by #47. Putting configuration in the ledger would
weaken the ledger's meaning, and it would force the application role to hold
privileges on `financial` that ADR-017 exists to deny it.

The immutability the catalogue does need is a different guarantee with a
different mechanism: **triggers and constraints on rows the application owns**,
not a grant-enforced append-only schema. The application must be able to move a
draft to published; it must never be able to rewrite what it published. That is
precisely what §3 and §4 encode.

### 12. No event and no `ServiceName` member

ADR-039 §8 is explicit: the contract reserves no enum member for an unimplemented
promise. Publishing a plan version has no consumer today — not Booking, not
Notification, not Analytics, not Search. Adding `CommercialPlanPublished` and a
`commercial` producer would create a contract that must be versioned, tested,
relayed and drained, and an outbox table that would need a subject-data claim
nobody could verify against a producer that writes nothing.

So this story defines no event, adds no `ServiceName` member and creates no
outbox table. When #40b needs one, that is an additive contract version and an
explicit story.

### 13. Boundaries with #40b, #40c and #40d

Stated so a reviewer can check the diff against them rather than against
intention.

| This story creates | This story does **not** create |
|---|---|
| Plan versions and price schedule versions | Any seller subscription row (#40b) |
| The `auto_assignable` flag and the seeded `D-7` version | Assignment of `D-7`, or any seller, to anything (#40b) |
| Tier resolution and exact totals as a domain service | Any purchase, checkout, quote or top-up route (#40c) |
| The catalogue rows a snapshot will later copy | The snapshot itself, and any grant or balance (#40c) |
| — | Consumption, return, overage or grace (#40d) |
| — | Recurring billing, gateway, provider or real collection (#46, #47) |
| — | Any seller-facing route, any UI, any frontend artifact |

There is **no seller-facing route of any kind** on this surface. Every route is
gated on `bc_manage_commercial_plans`, which no seller role holds.

### 14. The administrator contract is closed and rejects the unknown

Routes follow the platform's existing controller conventions and add nothing new:

- the actor is derived from authentication and never accepted from the request;
- request and response vocabularies are **closed** — every enumerated value is
  validated against an explicit list;
- **unknown fields are rejected, not ignored.** The global `ValidationPipe` runs
  with `whitelist: true, forbidNonWhitelisted: true`, so an unrecognised property
  is a 422 rather than a silently dropped field. The adversarial suite proves it
  on this surface specifically, because "the global pipe does that" is exactly
  the assumption that was wrong the last time a controller-level decorator was
  silently ignored;
- validation failures are distinguishable from authorization failures and from
  lifecycle conflicts, without leaking whether a given key exists to a caller who
  may not read it;
- read routes expose the catalogue and **not** audit internals. A version's
  actor columns are not in any response body: who published a plan is an
  administrative fact for the audit log, and disclosing it on a read would put
  administrator identity into every client that lists plans.

## Consequences

- Commercial terms can change indefinitely without any historical purchase ever
  being rewritten, because the schema makes the rewrite unwritable rather than
  merely discouraged.
- An administrator can make a mistake in a draft and cannot make one after
  publishing. That asymmetry is deliberate and is the reason drafts exist.
- Restoring last quarter's prices costs a new version rather than an edit, so
  the catalogue's history is a readable record of what was offered when.
- Two exclusion constraints and four triggers are more database machinery than
  this platform usually adds. Each one is here because an application-level
  equivalent would be defeated by a concurrent request, and the real-PostgreSQL
  suite proves each is enforced by the database rather than by the service.
- #40b, #40c and #40d inherit a catalogue they can only read and snapshot. None
  of them can widen a term retroactively, because there is no such operation.

## Rejected alternatives

### Mutable plan rows with an `updated_at`

Rejected. It is the model that makes "we changed the price and every existing
subscriber's invoice changed" possible, and no amount of application care
prevents it once the column is writable.

### A scalar `price_toman` column on the plan version

Rejected. `V33-DEC-009` requires tiered pricing for booking credits, so a scalar
plan price would be a second pricing mechanism that later has to grow tiers — and
the migration that grows it would have to rewrite published rows, which §4
forbids. A one-tier schedule costs one extra row and keeps exactly one pricing
mechanism in the platform.

### Application-level overlap checking

Rejected. Two administrators publishing overlapping windows concurrently would
both read a free timeline under READ COMMITTED and both commit. Issue #40 asks
for the constraint in the database specifically, and it is right to.

### `D-7` as a constant in the code

Rejected, and it is the single most important rejection in this ADR. A hardcoded
base plan is an implicit fallback wearing a plan's name: it would apply to
sellers with no row to prove it, it could not be versioned, retired or audited,
and the explicit subscription history `V33-DEC-009` asks for would not exist.
`auto_assignable` is a row's property, so the catalogue answers the question and
the code never knows the key.

### Closing the activation window when a version is retired

Rejected. It mutates a frozen field to express a fact the row already carries,
and it destroys the record of what was offered and for how long.

### Storing the catalogue on the Financial DataSource

Rejected. §11. Configuration is not a ledger, and the application must be able
to publish a draft — which the append-only financial role, correctly, cannot do
for anything.

### Emitting `CommercialPlanPublished` now

Rejected. ADR-039 §8. No consumer has been named, and a contract with no consumer
is maintenance, migration, test and security cost bought against a guess.

### Seeding a realistic paid plan alongside `D-7`

Rejected outright. Every price and allowance is open under #46, and a seed is a
published, immutable, activation-windowed commitment. There is no production
price in this story and none may be added until #46 closes.

## Open gates

- **#46** owns every commercial value: plan prices, included allowances, seats,
  locations, capability bundles, billing terms, minimum and maximum custom
  quantities, tier boundaries, UI presets, expiry, carry-forward, grace quantity,
  refundability, tax and invoice treatment, revenue recognition, and approved
  legal wording. None of them may be published from this story, including into
  a later `D-7` version.
- **#47** owns real paid subscription and top-up collection and settlement. It
  does not block this catalogue, and this catalogue does not unblock it.
- Widening the currency beyond `IRT` requires an owner decision and a migration.
