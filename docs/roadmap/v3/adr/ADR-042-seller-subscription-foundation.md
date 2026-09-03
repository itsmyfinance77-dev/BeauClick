# ADR-042 — A seller's entitlements are an immutable subscription snapshot, assigned rather than inferred

**Status:** ACCEPTED — 2026-09-03
**Approver:** product owner (`V33-DEC-018` ratified 2026-09-03)
**Backlog:** #56 (`#56a`)
**Depends on:** ADR-041 (the catalogue this story snapshots), ADR-027 (subject-data
contract), ADR-023 (business is its own party), ADR-018 (same-cluster
consistency), ADR-017 (financial isolation), ADR-011 (module boundaries)
**Constrains:** #69 (`#56b`), #57 (`#40c`), #58 (`#40d`)

## Context

ADR-041 built a catalogue of what *may* be sold and left one sentence for this
story: "assignment itself — creating a subscription row for a seller — is
**#40b** and is not implemented here."

That sentence is the whole problem. Until a seller holds a row, "what is this
seller entitled to?" has no answer, and every later story would have to invent
one. The invented answer is always the same shape — a constant, a default, a
`?? 200` — and `V33-DEC-009` forbids exactly that. A base workspace that is a
*row* rather than a fallback is the only way the question has an answer that can
be audited, versioned and refused.

`V33-DEC-018` closed the structure on 2026-09-03 after the Story #56 readiness
audit found the original issue bundled two separately deliverable outcomes. This
ADR records the architecture of the first: the foundation, with **no
seller-facing route of any kind**. The routes are #69.

## Decision

### 1. Module ownership and boundary

A second surface inside `services/commercial-policy`, as `subscription/`, beside
`catalogue/`. Not a new package.

It reads the catalogue's entities directly, shares its schema, its audit target
conventions and its subject-data contract. Splitting them would push the
snapshot copy across a package boundary for no benefit — and the snapshot is the
one operation whose correctness depends on reading the catalogue's exact bytes.
This mirrors how #40a added `catalogue/` beside Story #39's registry: a second,
additive surface in one service.

`financial-service` is untouched. Nothing here is a payment, receivable, payout
or revenue recognition; this is what a seller is *entitled to*, and no money
moves. `financial.*` grants are not altered.

### 2. The invariant everything else follows from

**Every eligible seller party has exactly one `active` subscription at every
instant, and a partial unique index — not a code path — is what makes it true.**

```sql
CREATE UNIQUE INDEX uq_seller_subscriptions_one_active_per_party
    ON commercial.seller_subscriptions (subscriber_party_type, subscriber_party_id)
    WHERE lifecycle_state = 'active';
```

`D-7` stops being a fallback the moment this holds, because there is no state in
which the platform must *guess* what a seller is entitled to. It reads a row, or
it refuses.

Everything below — the assignment mechanism, the lifecycle, the concurrency
model — is a consequence of keeping this true rather than an independent choice.

### 3. Subscriber party: resolved from ownership, once, then frozen

`V33-DEC-018` fixes three properties, and the third is the one that costs
something.

- Resolved **server-side**, from ownership only.
- Resolved **once**, at creation, and snapshotted onto the row.
- **Never re-resolved** — not on read, not on mutation, not ever.

#### Why the existing resolver could not be reused

`ProviderBackedFinancialPartyResolver` (ADR-023 §3) resolves a session user to
one party: a business owner *is* the business; otherwise a professional is their
own party **unless** `business_staff` shows an active affiliation, in which case
their earnings belong to the employing business.

That third branch is correct for earnings and wrong for subscriptions. Re-reading
it would mean a professional joining a salon silently re-points "my
subscription" at the salon — which `V33-DEC-018` forbids, and which
`V33-DEC-010` already forbade for returns in the same words: *"the seller's
current affiliation is never re-resolved"*.

So `OwnedSubscriberPartyResolver` is a **new, narrower** resolver with no
staff-affiliation branch. It is not a refactor of the financial one and must not
become one: the two answer different questions and are correct in different ways.

#### It returns a set, not a party

`provider.professionals.owner_id` and `business.businesses.owner_id` are two
independent unique indexes, so one user may own a professional **and** a
business. The financial resolver picks business-first because earnings need one
answer. Subscriptions need both: `V33-DEC-018` gives each *party* a subscription,
not each user, and a user owning two parties owns two subscriptions with no
relationship between them.

This is the direct reason the resolver returns `OwnedSubscriberParty[]` and the
reason a cross-party read is structurally impossible: nothing in the domain ever
holds a "the user's subscription", only "this party's subscription".

#### Staff can never mutate

An affiliated staff member owns neither party, so the resolver returns nothing
for the employer. The capability #69 will add is not what protects this — the
resolver is. A capability check that passed would still find no owned party to
act on.

### 4. The base workspace is assigned twice, by two mechanisms that must agree

`V33-DEC-018` ratifies two paths, and the reason there are two is that existing
sellers and future sellers are genuinely different problems:

| Path | Covers | Mechanism |
|---|---|---|
| Migration backfill | Every eligible party that already exists | One `INSERT … SELECT` per party type, in the migration's own transaction |
| Lazy ensure | Every party created afterwards | `ensureBaseSubscription(party)`, idempotent, called by later stories |

**They converge on the same invariants** because both go through the same index
and the same CHECK constraints. Neither is allowed to be the "real" one.

Rejected, and why:

- **An event.** ADR-041 §12 and `V33-DEC-018` both refuse an event with no named
  consumer. There is none.
- **A scheduler or timer.** The platform has none, and inventing one to assign a
  row nobody is waiting for is infrastructure bought for nothing.
- **A seller-creation hook.** It cannot reach sellers who already exist, so it
  would need the backfill anyway — and then two mechanisms would run for new
  sellers, which is how they drift.

#### `D-7` is still never named in code

The migration and the service both ask the same question ADR-041 §6 designed the
`auto_assignable` flag to answer: *which version is auto-assignable at this
instant?* `ex_plan_versions_single_auto_assignable` guarantees at most one
platform-wide, so the question has one answer or none.

When it has none, both paths **fail explicitly**. For the service that is a
refusal; for the migration it means the migration fails. That is deliberate and
it has a visible cost worth stating: **migration success now depends on
catalogue state.** A database whose administrator retired `D-7` with nothing
auto-assignable published will not migrate until they publish one. The
alternative — skipping quietly — would leave sellers with no subscription and
reintroduce, as an empty table, exactly the implicit fallback this story exists
to delete.

### 5. The snapshot copies values; the foreign key is only provenance

A subscription stores `plan_version_id` **and** a full copy of every entitlement.
The foreign key alone would be sufficient today, because ADR-041's rows are
immutable — and it would still be wrong.

"The terms this seller holds" and "the terms this version describes" are
different facts. They are equal today and need not stay equal: the moment #46
introduces any per-seller variation, reconstructing history through a join
rewrites the past. Copying is what makes the snapshot a fact rather than a view.

Copied: plan key, version, billing term, included booking credits, staff seats,
included locations, capability keys, currency, unit price, price schedule
version, and the effective instant.

#### Where the price comes from, and where it does not

The unit price is read from the tiers of the schedule version the plan version
**points at** (`price_schedule_version_id`), not from
`resolvePrice(scheduleKey, at, quantity)`.

`resolvePrice` resolves whichever schedule version is *active at an instant*,
which need not be the one this plan version references. For a quote that is
right; for a snapshot it would silently attach a price the seller was never
offered. A `seller_plan` schedule's quantity domain is exactly one — a
subscription is selected singly — so the tier covering quantity 1 is the price.

#### Immutability is a trigger, not a convention

A row trigger refuses `UPDATE` of every snapshot column and of the party
columns, permitting only the lifecycle transition columns. The same mechanism
`tg_plan_versions_lifecycle` uses, for the same reason: a value that must never
change is protected where it lives, not wherever somebody remembers to check.

A later `D-7` version therefore cannot migrate existing subscribers, because
nothing can rewrite their rows. Moving them is a separate owner decision and a
separate visible migration — recorded in `V33-DEC-018`, and out of scope here.

### 6. Zero-price is a database constraint because a comment is not a boundary

```sql
CONSTRAINT ck_seller_subscriptions_zero_price_only
    CHECK (snapshot_unit_price_toman = 0)
```

`V33-DEC-018` permits only zero-price activation while #46 and #47 are open, and
requires it enforced in PostgreSQL rather than only in application code.

The constraint is unconditional rather than scoped to `active`, and that is the
stronger form on purpose: a paid subscription cannot be written **in any state**,
so there is no `superseded` or `cancelled` row that a later bug could revive into
a paid active one.

What this refuses to build, because `V33-DEC-018` names each one: no pending
payment intent, no awaiting-payment state, no draft-paid or sandbox-paid
subscription, no order, no payment intent, no ledger entry, no provider call. A
dormant "awaiting payment" row is not a smaller version of paid activation — it
is a state machine that #46 and #47 will define differently, committed to before
they have spoken.

Removing the constraint is a later, visible migration once the required decisions
and a payment fact model exist. That visibility is the point: a review sees a
migration named after what it does.

### 7. Lifecycle: two transitions, and no way back

`active -> superseded` and `active -> cancelled`. Nothing else is reachable.

- **Upgrade and downgrade are not transitions.** They supersede the active row
  and insert a new one carrying a new snapshot, in one transaction. History is
  immutable for free, because nothing was edited.
- **Cancellation ensures the base workspace** in the same transaction, so the
  §2 invariant never breaks — a seller is never briefly entitled to nothing.
- **Issued grants are never touched** by any transition. `V33-DEC-018` and
  `V33-DEC-010`'s grant-durability clause both require it.

Transitions are compare-and-swap, with the expected state in the `WHERE`:

```sql
UPDATE … SET lifecycle_state = $2 WHERE id = $1 AND lifecycle_state = 'active'
```

Two concurrent changes mean one matches a row and one sees `affected = 0` and is
refused. The same shape `CommercialCatalogueService.transitionPlanVersion`
already uses.

Immediate rather than future-effective, because a future-effective change needs
something to make it take effect later — a scheduler, which nobody has approved.

### 8. Grants: once, from the snapshot, and written even when they are zero

Issued exactly once at activation, with quantities read from the **subscription's
snapshot** rather than from a fresh catalogue lookup. Reading the catalogue again
would make the grant depend on when it ran.

**A zero-quantity grant is written.** The seeded `D-7` confers zero credits, and
skipping the row would make its absence ambiguous between "conferred nothing" and
"not processed yet" — the implicit-fallback shape again, wearing an empty table.
`V33-DEC-018` requires the fact.

De-duplication is structural:

```sql
CONSTRAINT uq_booking_credit_grants_once
    UNIQUE (subscription_id, source, period_index)
```

**No recurrence.** `billing_term_days IS NULL` on every publishable version
today — the seeded `D-7` has no recurring term, and NULL is deliberately
different from a zero somebody could read as "renews immediately". Recurrence is
therefore unreachable rather than missing, and it stays unwritten until #46
publishes a version with an approved term and its own scheduler decision.

**Expiry is structurally unwritable.** The column exists because `V33-DEC-010`
permits the model to carry one, and a CHECK pins it:

```sql
CONSTRAINT ck_booking_credit_grants_no_expiry CHECK (expires_at IS NULL)
```

No route, DTO, service argument or default can set it, and the constraint means
even raw SQL cannot. Activating expiry is a visible migration after Legal
approves — proved by a test with a mutation probe, because a comment saying
"never write this" is not a guarantee.

### 9. One transaction, one manager

Activation covers, atomically: the subscription insert, the uniqueness
arbitration, the snapshot, the grant including a zero one, and the audit rows.
A failure anywhere rolls back everything.

**Every port used inside the transaction takes the caller's `EntityManager`.**
No adapter may open its own pool connection while the transaction is open — a
second connection cannot see the uncommitted row and would not roll back with
it. `AdminAuditService.record(manager, …)` already has this shape; the resolver
and grant service are written to match.

`recordDetached` is **not** used. It exists for a physically separate DataSource
or an external system, and there is neither here.

### 10. The audit log becomes the platform audit trail, deliberately

`V33-DEC-018` rules that `admin.admin_audit_log` is reused and no second audit
engine is built. This widens the table's charter from *administrative* actions to
platform actions, and the widening is recorded here rather than left for a reader
to notice.

The reasoning: its value is the grant separation — owned by
`beauclick_admin_audit_owner`, with the application holding `INSERT, SELECT` and
no way to grant itself `UPDATE` or `DELETE`. Subscription history needs exactly
that property. A second trail would either duplicate the role separation or lack
it, and `V33-DEC-018` forbids duplicating it.

Two constraints follow, and the second is a security property:

- **Actors.** System assignment uses `actor_label = 'system'`; the backfill uses
  `actor_label = 'migration:v3.3-a'`, matching #40a's seed convention. No human
  is fabricated for an automatic action. The table's existing
  `ck_admin_audit_actor` already permits exactly this.
- **Reasons are closed, server-generated values.** No DTO or internal API accepts
  free-text audit prose. User-controlled text must never reach a table the
  application cannot `UPDATE` — an append-only log is worth having only if
  nobody can write arbitrary content into it.

Actions recorded: `commercial.subscription_assigned`,
`commercial.subscription_activated`, `commercial.subscription_superseded`,
`commercial.subscription_cancelled`, `commercial.credits_granted`.

### 11. ADR-027: both tables are `retained`, and neither is empty

| Table | Disposition | Reason |
|---|---|---|
| `commercial.seller_subscriptions` | `retained` | Carries `selected_by_user_id` and `cancelled_by_user_id`, and is the immutable record of what the platform was obliged to provide a seller. |
| `commercial.booking_credit_grants` | `retained` | Operational evidence of entitlements conferred, referenced by #58's consumption rows. |

Neither may be claimed `no_subject_data` — and the two are protected
differently, which is worth stating rather than blurring.

`seller_subscriptions` carries `created_by_user_id` and `cancelled_by_user_id`,
so ADR-027's `wrongly_declared_empty` check catches a dishonest claim on it
automatically. **`booking_credit_grants` carries no `_user_id` or `_by` column
at all** — a grant is issued by the system and there is no actor to record — so
the detector would *not* catch one. Its `retained` disposition rests on the
claim's stated reason and on the suite that asserts it, not on a structural
backstop.

Adding a permanently-NULL `granted_by_user_id` so the detector fires was
rejected: inventing a column to satisfy a check is the mirror image of the
evasion ADR-027 forbids, and it would make the schema less honest in order to
make a document more comfortable. The asymmetry is real, so it is recorded.

**Erasure genuinely does nothing here, and the report says so.** `provider`
anonymizes a professional in place — tombstone alias, `bio` nulled, `deleted_at`
set — and the row and its id survive. A subscription keyed by `professional_id`
therefore stays referentially valid after erasure, with the identifying
attributes already removed by the module that owns them. Counts are truthful:
zero anonymized, zero deleted, both tables named as retained.

**Export returns the subject's own commercial facts only**, and only when they
own the party. A staff member receives nothing: they are not the subscriber, and
returning their employer's terms through a personal export would disclose another
party's data through a route that is not an authorization boundary.

### 12. No event, no `ServiceName` member, no notification

Every outcome here is a synchronous database fact read by the same application.
Analytics needs nothing from subscriptions, search needs nothing, and no approved
subscription message exists.

The temptation is grant issuance, where an outbox feels natural. It is refused
for the reason ADR-041 §12 gives: an outbox with no consumer is a table that
accumulates rows nobody drains.

### 13. Boundaries with #69, #57 and #58

| This story creates | This story does **not** create |
|---|---|
| Subscription and grant tables, with their constraints and triggers | Any HTTP route, controller or DTO (#69) |
| `OwnedSubscriberPartyResolver` and the lifecycle service | `bc_manage_own_subscription`, or any seller capability grant (#69) |
| `D-7` backfill and idempotent lazy ensure | Plan selection by a seller (#69) |
| One-time grants from the snapshot | Custom-quantity purchase, top-ups, quotes (#57) |
| The grant rows a balance will later be derived from | A balance table, consumption or return (#58) |
| — | Any payment fact, order, intent, ledger entry or provider call |
| — | Recurring billing, renewal, a scheduler, or expiry activation |

There is **no seller-facing route on this surface**, and no capability is granted
to any seller role.

## Consequences

- A seller's entitlements are readable as a row for the first time, so #58 can
  ask a question with an answer instead of a default.
- Existing sellers gain a subscription at migration time, and migration now
  depends on the catalogue holding an auto-assignable published version (§4).
- Subscriptions accumulate rather than update, so history is complete and the
  tables grow by one row per change. That is the intended trade.
- The zero-price CHECK means the platform is structurally incapable of recording
  a paid subscription until a visible migration removes it.
- `admin.admin_audit_log` now carries non-administrative rows (§10).
- A user owning two seller parties holds two independent subscriptions with no
  relationship — correct under `V33-DEC-018`, and something #58 must handle when
  it decides which balance a booking draws from.

## Rejected alternatives

### Reusing `ProviderBackedFinancialPartyResolver`

Its staff-affiliation branch is right for earnings and wrong for subscriptions
(§3). Reusing it would transfer a professional's subscription to their employer
on affiliation, which `V33-DEC-018` and `V33-DEC-010` both forbid.

### Storing only `plan_version_id` and joining for terms

Correct today, wrong the moment terms vary per seller, and it makes history a
view rather than a fact (§5).

### A `pending_payment` or `awaiting_activation` state

Refused by name in `V33-DEC-018`. It is a state machine committed to before #46
and #47 have defined one, and a dormant paid row is exactly the sandbox shortcut
that survives into production (§6).

### Skipping the zero-quantity grant

It would make an absent row ambiguous between "conferred nothing" and "not
processed", which is the implicit fallback this family exists to delete (§8).

### A generic idempotency-key table

The two unique indexes do the whole job. A key table would be infrastructure for
a problem the schema already solves.

### A materialised balance column

Balance is `SUM(grants) − SUM(consumptions)`, and consumption is #58. A balance
now would be a column with no writer on one side of its own arithmetic.

### Emitting `SellerSubscriptionAssigned`

No consumer (§12).

## Open gates

- **#46** owns every commercial value the base workspace will eventually carry:
  included credits, seats, locations, capability bundles, billing terms, expiry
  and carry-forward. None may be published from this story.
- **#47** owns real paid subscription collection. It does not block this
  foundation, and this foundation does not unblock it.
- **Moving existing subscribers to a newer `D-7` version** is a separate owner
  decision and a separate migration (`V33-DEC-018`, §5).
- **Which balance a booking draws from** when a professional is affiliated with a
  business is #58's to implement, from the ruling `V33-DEC-018` already records.
