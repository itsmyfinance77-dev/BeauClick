# ADR-017: Financial Isolation Boundary and Money Representation

**Status:** Accepted — implemented and verified in Phase 2 (2026-08-20).
**Supersedes in part:** `V3_DATABASE_BLUEPRINT.md` §1's "separate database" specification for `financial` and `payment`.
**Related:** ADR-004 (database strategy), ADR-009 (financial ledger), ADR-002 (architecture style).

## Context

Phase 2 had to make two decisions the Phase 0 corpus left either under-specified or, on evidence, wrong.

**1. How financial isolation is actually achieved.** `V3_DATABASE_BLUEPRINT.md` §1 specifies a physically separate *database* for `financial` and for `payment`, on the reasoning that "a compromised or buggy `apps/api` process should not even hold a connection string capable of touching the ledger". That goal is correct and important. The chosen mechanism, on closer inspection, is not the only way to reach it — and it has a cost the blueprint did not price.

**2. How money is represented.** `V3_DATABASE_BLUEPRINT.md` and ADR-009 both assume integer amounts but never state the unit, the column type, or the rounding policy. V2 used `INT` columns holding integer Toman, with `(int) round($net * $rate / 100)` at each call site.

## Decision

### Financial isolation: a separate ROLE and CONNECTION, not a separate database

`financial` is a schema in the same PostgreSQL cluster, but:

- its tables are owned by `beauclick_financial_owner`, a **NOLOGIN role the application does not have**;
- financial-service connects on its **own `DataSource`** as `beauclick_financial_writer`, holding `INSERT` + `SELECT` and nothing else;
- the main application role has **`REVOKE ALL ON SCHEMA financial`** — the pool every controller, guard, and background job shares cannot so much as `SELECT` from the ledger;
- `UPDATE`/`DELETE`/`TRUNCATE` are never granted to any application role, on any financial table (the sole exception being `UPDATE` on `financial.outbox_events`, which holds delivery receipts, not financial facts).

**Why this rather than a separate database.** The isolation property the blueprint wanted is delivered in full — verified empirically, not assumed. What a separate database would additionally do is make a `booking` + `commerce` transaction impossible, since those are different schemas that must commit atomically (a booking without its order is a slot held for nothing; an order without its booking is a charge for nothing). A separate database forces a saga or a distributed transaction onto a consistency problem that has a perfectly good ACID answer available.

The role boundary is also, in one respect, *stronger* than the blueprint's: because the application role is not the schema owner, it cannot grant itself back what was revoked. A separate database whose owner is the application role would not have that property.

**Payment stays on the shared connection**, unlike financial. Payment data is not append-only and has no immutability guarantee to protect; what payment needs is idempotency and correct state transitions, both of which are enforced by constraints rather than grants. Giving it a second connection would add operational surface for no property gained.

### Money: integer Toman in `BIGINT`

- **Unit: Toman**, not Rial minor units. Iran has no ISO-4217 code for Toman (it is a colloquial Rial/10), and every price this product has ever stored, displayed, or reasoned about is an integer Toman with no subunit. Re-basing to Rial would multiply every historical and conceptual figure by 10 and invite exactly one class of catastrophic off-by-10× bug, for zero modelling benefit. Toman *is* the minor unit for this currency in this product.
- **Column type: `BIGINT`**, widened from V2's `INT`, which caps at 2,147,483,647 Toman — reachable by a party's lifetime ledger sum. A silent overflow in a ledger is unacceptable.
- **A TypeORM transformer on every money column.** node-postgres returns `BIGINT` as a *string*; without this, `amount + amount` would concatenate rather than add — a silent, catastrophic bug that type-checks cleanly at the driver boundary.
- **Rates in basis points**, not V2's integer percent, so 12.5% is representable. Every ledger row captures its rate at write time.
- **`splitExact()` is the only way an amount is divided.** It guarantees `part + remainder === total` exactly, for every input including negatives, by computing the remainder through *subtraction* rather than a second independent rounding. Two independent roundings are how a ledger ends up one Toman short of the money that actually moved.
- **`roundHalf()` rounds half away from zero**, unlike `Math.round`, which is asymmetric across zero (`Math.round(-0.5) === -0`). Symmetry is required so that a refund reversal is the exact negative of the split it reverses.
- **Out-of-range or fractional values throw**, never round. A misconfigured commission rate must be a loud failure, not a silently-clamped number that quietly mis-splits real money (V2 clamped with `max(0, min(100, $rate))`).

## Consequences

- **Positive:** GAP-01 is closed structurally rather than by convention, and proved against a real server — `UPDATE`/`DELETE`/`TRUNCATE` denied on the ledger and both settlement tables, rows verified byte-identical afterwards, with the connecting role asserted non-superuser so the result cannot pass for the wrong reason. Cross-schema ACID transactions stay available where they genuinely help.
- **Positive:** the money rules are enforced in one library with an exhaustive test suite, rather than re-derived at each call site.
- **Negative:** two connection pools to configure and monitor instead of one, and a role-bootstrap step (`database/scripts/financial-roles.sql`) that must run once per environment *before* the financial migration. `FINANCIAL_DATABASE_URL` is mandatory and the application **refuses to boot without it** — silently falling back to the main connection would quietly void the whole guarantee, which is the one failure mode most worth being loud about.
- **Negative:** the financial outbox cannot be drained by the same relay instance as the other schemas, since a relay holds exactly one `DataSource`. Phase 2 has no consumer for financial events, so this is recorded rather than solved.
- **Risk:** these grants were verified on a local PostgreSQL 16 instance. A managed provider must be re-verified with the same script before production relies on it — the *capability* doubt that made GAP-01 unresolvable in V2 is gone, but a specific host's behaviour is still a specific host's behaviour.

## Alternatives considered

- **Separate physical databases, as the blueprint specified.** Rejected for the reasons above: same isolation, strictly worse consistency options. Revisit if financial ever needs independent scaling or a different retention/backup regime — at which point the schema moves and the connection string changes, and nothing else does, because financial-service already talks to its own `DataSource`.
- **Triggers enforcing append-only, as V2 attempted.** Rejected: grants are simpler, cannot be dropped by the application role, and have no `SUPER`-privilege precondition — the exact thing that defeated V2's attempt.
- **Rial minor units.** Rejected above.
- **A `Money` class rather than a branded integer.** Considered and rejected for Phase 2: every amount crosses a TypeORM boundary and a JSON boundary, and a class would need serializing at both. The functions in `@beauclick/money` give the same invariants with no marshalling cost. Revisit if multi-currency ever arrives, which would be the real reason to want a class.
