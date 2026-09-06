# ADR-047 — A custom credit purchase is an immutable price snapshot taken against an administrator-bound schedule

**Status:** ACCEPTED — 2026-09-06
**Approver:** product owner (`V33-DEC-026` and `V33-DEC-027` ratified 2026-09-06)
**Backlog:** #57 (`#40c-1`)
**Depends on:** ADR-041 (the catalogue this story prices against), ADR-042 (the
subscription that carries the binding), ADR-046 (the balance these credits will
one day enter), ADR-027 (subject-data contract), ADR-018 (same-cluster
consistency), ADR-011 (module boundaries)
**Constrains:** #99 (`#40c-2`)

## Context

A seller may want more booking credits than a plan includes. `V33-DEC-009`
ratified how they would be priced — immutable versioned tier schedules, a flat
price expressed as a one-tier schedule, exact integer Toman — and left
everything else open.

`V33-DEC-026` then split the story. The half that can be built has no payment in
it at all: a seller asks for a quantity, the server prices it from the
administrator's catalogue, and the result is recorded so immutably that a later
price change cannot rewrite it. The half that cannot be built is the payment,
because **no gateway adapter exists in this repository** — the only
`PaymentProvider` is the sandbox, and `NODE_ENV=production` disables it. That
half is #99, blocked on #47.

`V33-DEC-027` then closed the question `V33-DEC-026` had left open, which a code
audit found before any code was written: **nothing said which price schedule
prices a quantity.** `resolvePrice` needs a schedule key, the seller may not
supply one, several `booking_credit` schedules are legal, and
`ex_price_schedule_versions_no_overlap` is scoped to a single key — so two keys
may each hold a version active at the same instant with nothing to choose
between them.

This ADR records how both decisions are implemented.

## Decision

### 1. The pricing source is bound by an administrator, to an immutable plan version

`commercial.plan_versions` gains a **nullable** `booking_credit_schedule_key`.
It names a `commercial.price_schedules` row whose `purpose` is exactly
`booking_credit`.

Nullable, because most plan versions will not offer custom credits and because
the seeded `D-7` must stay honestly unconfigured. A plan version is already
immutable once published, so the binding inherits that for free — and
`enforce_plan_version_lifecycle` is extended to say so rather than left to
imply it.

**Rejected:** a client-supplied key (a client-chosen price source is a
client-chosen price); the first or lexicographically-first active schedule
(makes price a function of row order or of an administrator's naming); a
hard-coded key or environment variable (`V33-DEC-009` forbids a commercial value
as a code constant, default or fallback, and an environment variable is a
commercial decision made by whoever edits a file); a rule that only one
`booking_credit` schedule may ever exist (buys determinism by foreclosing
per-plan pricing, quietly answering a #46 question).

### 2. The wrong-purpose refusal is a storage invariant, not a check

`V33-DEC-027` Ruling 7 requires that a binding to a `seller_plan` schedule be
**unwritable**, and forbids satisfying it with a comment or a controller check.

The narrowest mechanism this schema already knows is a **composite foreign key
through a redundant, generated discriminator** — the shape `#58a` used for
`fk_bcc_grant_identity`:

```sql
ALTER TABLE commercial.price_schedules
    ADD CONSTRAINT uq_price_schedules_key_purpose UNIQUE (schedule_key, purpose);

ALTER TABLE commercial.plan_versions
    ADD COLUMN booking_credit_schedule_key VARCHAR(64),
    ADD COLUMN booking_credit_schedule_purpose VARCHAR(24)
        GENERATED ALWAYS AS (
            CASE WHEN booking_credit_schedule_key IS NULL THEN NULL ELSE 'booking_credit' END
        ) STORED,
    ADD CONSTRAINT fk_plan_versions_booking_credit_schedule
        FOREIGN KEY (booking_credit_schedule_key, booking_credit_schedule_purpose)
        REFERENCES commercial.price_schedules (schedule_key, purpose);
```

The discriminator is **generated, not supplied**, so no writer can assert a
purpose the schedule does not have; the composite FK then makes a `seller_plan`
key structurally unreferenceable. A trigger would also work and was considered,
and this was preferred because a foreign key is declarative, is enforced on
`price_schedules` deletion as well as on insert, and needs no PL/pgSQL to read.

**A `CHECK` alone cannot do this** — a CHECK sees only its own row and cannot
consult `price_schedules`.

### 3. The subscription snapshots the key, not the version

`commercial.seller_subscriptions` gains a nullable
`snapshot_booking_credit_schedule_key`, copied from the selected plan version at
**every** activation path: automatic base assignment, explicit selection, and
the base-workspace restoration after cancellation.

This is ADR-042 §5's rule — a subscription reads its own snapshot, never live
catalogue state — extended to one field. `tg_seller_subscriptions_immutable`
covers it, so a plan edit, a supersession or an affiliation change cannot
redirect an existing subscription's pricing source.

**The schedule VERSION is deliberately not snapshotted.** Binding a version
would freeze that subscription's top-up price at activation, so an administrator
could never reprice credits without rewriting immutable rows. Binding the key
lets prices move forward while every purchase keeps what it was offered.

### 4. The active version is resolved per request, inside the caller's transaction

`CommercialCatalogueService` gains `resolveBookingCreditPriceWithin(manager,
scheduleKey, at, quantity)`. It:

* uses the caller's `EntityManager`, so the price the purchase snapshots and the
  purchase row itself are read and written on one connection in one transaction;
* verifies `purpose = 'booking_credit'` on the schedule — a second, cheap check
  beside the storage invariant, so a misuse fails with a typed refusal rather
  than a foreign-key error;
* takes **one captured instant** and applies the same two live conditions the
  rest of the catalogue applies: `lifecycle_state = 'published'` and the instant
  inside `[activation_starts_at, activation_ends_at)`;
* never guesses a latest, nearest or default version;
* returns the exact `scheduleVersionId` and `tierId` alongside the pure quote.

The existing `resolvePrice(scheduleKey, at, quantity)` keeps its signature and
delegates, so #40a's callers and their tests are untouched.

### 5. Pure arithmetic stays pure; identity is attached, never fabricated

`resolvePriceV1(terms, quantity)` computes from *values* — tier bounds and a
unit price — and cannot know which rows those came from. It is left exactly as
it is.

The contract adds `ResolvedPriceQuoteV1`, which is a `PriceQuoteV1` plus
`scheduleKey`, `scheduleVersionId`, `tierId` and the resolution instant, and
`attachPriceIdentityV1` to compose the two. The service supplies real ids; the
contract never invents one and no identity field is optional.

The tier row is matched back by `minQuantity`, which
`ex_price_tiers_no_overlap` makes unique within a version — so the match is a
storage guarantee, not a heuristic.

### 6. The purchase row is the record, and it is immutable

`commercial.credit_purchases` snapshots, in one statement:

| Group | Columns |
|---|---|
| Party | `subscription_id`, `subscriber_party_type`, `subscriber_party_id` |
| Ask | `quantity` |
| Price source | `schedule_key`, `price_schedule_version_id`, `price_tier_id` |
| Money | `unit_price_toman`, `total_toman`, `currency_code` |
| Time | `effective_at`, `created_at` |
| State | `lifecycle_state` |
| Request | `request_key`, `requested_by_user_id` |

PostgreSQL enforces every claim the row makes:

* `ck_credit_purchases_total CHECK (total_toman = unit_price_toman * quantity)` —
  the arithmetic is not an application invariant. `unit_price_toman` is
  `BIGINT`, so the product is computed in `bigint` and the separate
  `ck_credit_purchases_money` bound (`total_toman <= 10_000_000_000_000`, the
  same `MAX_AMOUNT_TOMAN` the catalogue uses) is reachable rather than
  short-circuited by an overflow. `quantity <= 1_000_000_000` and
  `unit_price_toman <= 10_000_000_000_000` together bound the product far below
  `bigint`'s range, so the CHECK returns a controlled violation instead of
  `22003`.
* `ck_credit_purchases_currency CHECK (currency_code = 'IRT')`.
* `ck_credit_purchases_quantity CHECK (quantity BETWEEN 1 AND 1000000000)` — a
  **representational** guard, the same one `price_schedule_versions` carries.
  The commercial minimum and maximum come from the administrator's schedule and
  are enforced by the pricing engine's `quantity_out_of_bounds`.
* `ck_credit_purchases_lifecycle CHECK (lifecycle_state IN ('awaiting_payment','abandoned'))`.
* `uq_credit_purchases_request UNIQUE (subscription_id, request_key)`.
* `fk_credit_purchases_subscription_party` — a composite FK to
  `uq_seller_subscriptions_identity (id, subscriber_party_type,
  subscriber_party_id)`, so a purchase cannot claim a party its own subscription
  does not have.
* `fk_credit_purchases_schedule_version` — composite to
  `uq_price_schedule_versions_key_version_identity (id, schedule_key)`, so the
  version must belong to the key the row names.
* `fk_credit_purchases_tier` — composite to `uq_price_tiers_identity (id,
  schedule_version_id)`, so the tier must belong to that version.
* `tg_credit_purchases_immutable` refuses **DELETE outright** and refuses any
  UPDATE that changes a snapshot column. `lifecycle_state` is the single
  exception, and only `awaiting_payment → abandoned`; `#99` will widen it to
  `awaiting_payment → paid` when a verified payment exists.

The three composite foreign keys are the same technique `#58a` used for
`fk_bcc_grant_identity`: consistency between rows that a single-row CHECK cannot
express.

### 7. The seller surface adds three routes and no capability

Under the existing `/api/v1/me/subscriptions/:workspaceRef` namespace:

| Route | Guard |
|---|---|
| `POST .../credit-purchases/quote` | authenticated + live ownership |
| `POST .../credit-purchases` | `bc_manage_own_subscription` + `Idempotency-Key` |
| `GET .../credit-purchases` | authenticated + live ownership |

The read/quote versus mutation split is #69's, unchanged: `V33-DEC-020` Ruling 9
established that enforcing a seller capability on a *read* would lock legitimate
sellers out, and a quote is a read that happens to be a POST because a quantity
belongs in a body.

Every DTO declares only `quantity`. `forbidNonWhitelisted` makes any other field
a `400` rather than a silently stripped value — the difference `V33-DEC-019`
insisted on, because a stripped `partyId` reads to the caller as if it were
honoured.

### 8. One public refusal, spelled as ratified

Every pricing cause — a null binding, a missing schedule, a wrong-purpose
schedule, no active published version, incomplete tiers, an out-of-bounds
quantity, a concurrent catalogue change — collapses to the single public code
**`purchase_unavailable`**.

The code is lower-case, which differs from every other code in this repository.
That is deliberate: `V33-DEC-026` Ruling 8 wrote it that way and the register is
the authority on a ratified contract. The deviation is recorded here so it reads
as a decision rather than an oversight.

Ownership refusals are untouched and keep `SUBSCRIPTION_SELLER_NOT_ELIGIBLE`, so
malformed, foreign, stale and nonexistent references stay byte-identical.

### 9. Audit and privacy

A created purchase writes one `admin.admin_audit_log` row through
`AdminAuditService.recordSystem`, **inside the caller's transaction** — the
correction `#58a` had to make after auditing a ledger through a logger whose
lines survive a rollback. The action and reason are closed constants beside
`#56a`'s. A replayed idempotency key writes no second row.

`commercial.credit_purchases` is claimed **retained** under ADR-027: it records
an obligation the platform undertook. Export returns the owning seller's own
purchase facts — quantity, unit price, total, currency, lifecycle and instants —
and omits `request_key`, `requested_by_user_id` and every administrative
identity. Erasure deletes and anonymizes nothing and says so with truthful
counts. A staff member receives nothing, because the ownership predicate is
ownership.

### 10. The absolute boundary

**This story writes no booking-credit grant, and contains no code path that
could.** `ck_booking_credit_grants_source`, `uq_booking_credit_grants_once`,
`uq_bcg_identity`, `fk_bcc_grant_identity`, the grant entities and services and
`#58a`'s balance algorithm are all untouched. It creates no payment fact, order,
payment intent or ledger entry, calls no provider, emits no event and adds no
`ServiceName` member.

## Consequences

**Story #57 ships safely unavailable.** `D-7` and every existing subscription
keep a null binding and nothing is backfilled, so the routes exist and refuse
until an administrator performs three deliberate acts: create a `booking_credit`
schedule, publish a version of it, and publish a plan version carrying its key.

That is the shape `#58a` shipped in — a complete mechanism, dormant until
somebody with the authority configures it, rather than a mechanism with a
default nobody decided. The alternative was to seed a schedule, which
`V33-DEC-009` forbids and which would have put a price in a migration.

**An administrator can reprice credits at will.** Publishing a new version of a
bound key changes what later requests cost, changes no existing purchase, and
moves no subscription. That property is the reason the binding is to a key.

**#99 inherits a complete record.** The verified payment fact it will record is
matched against a purchase whose price was already fixed and made immutable
here, so it re-resolves no schedule, version, tier or price.

## Open gates

- Real seller-to-platform collection, and therefore any paid activation — #47,
  then #99.
- Every commercial value: prices, tiers, minimum and maximum purchasable
  quantity, UI presets, quote validity, refund and clawback, expiry, tax and
  revenue recognition — #46, configured through the administrator catalogue.
- Whether credit pricing should vary by plan at all — #46. The structure
  permits it; this ADR does not decide it.
