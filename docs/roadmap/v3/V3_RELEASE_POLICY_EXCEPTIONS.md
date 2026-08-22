# V3 Release Policy Exceptions

A release-policy exception is a **deliberate, recorded decision to release despite an
unmet release criterion**. It is not a gap closure, not a re-classification of the
underlying work, and not a statement that the criterion no longer matters. Every
exception here names what remains unsatisfied, why releasing anyway is acceptable, what
prevents the gap from causing harm in the meantime, and exactly what must happen before
the exception can be retired.

Nothing in this document closes a gap. `V3_GAP_REGISTER.md` remains the authority on gap
status; this document is the authority on **release decisions taken with a gap still
open**.

---

## EXC-001 — V3.0.0 Payment Sandbox Release Exception

| Field | Value |
|---|---|
| **Exception ID** | EXC-001 |
| **Title** | V3.0.0 Payment Sandbox Release Exception |
| **Decision date** | 2026-08-23 |
| **Status** | ACTIVE |
| **Applies to** | The `v3.0.0` release only |
| **Underlying gap** | `GAP-06b` — real production payment gateway — OPEN / EXTERNAL_CONFIGURATION |
| **Owner / approving authority** | Project owner (repository owner), by explicit written release-policy direction |
| **Retires when** | GAP-06b is genuinely closed — a real gateway adapter exists, real merchant credentials are configured, and the production activation checklist (§ Production activation requirements) is fully satisfied and verified |

### The unmet criterion

`V3_IMPLEMENTATION_ROADMAP.md`'s Phase 2 acceptance criteria requires the core booking
loop to run *"against a real (even sandbox) payment gateway"*, and `V3_GAP_REGISTER.md`'s
original GAP-06 wording calls a real gateway an *"explicit precondition for a real V3
launch, not merely a code gap."*

`V3_PHASE5_IMPLEMENTATION.md` §9 and `V3_RELEASE_AUDIT.md` §3 both concluded — correctly,
and deliberately refusing to decide it themselves — that a locally-simulated bank does not
satisfy that criterion as written, and that whether to release anyway is *"a release-policy
decision for a human to make explicitly, not one this phase may take silently."*

**This document is that decision.**

### The decision

`v3.0.0` **may be released** with:

- **Sandbox payment lifecycle — VERIFIED** (GAP-06a, RESOLVED)
- **Production payment gateway — NOT CONFIGURED** (GAP-06b, OPEN / EXTERNAL_CONFIGURATION)

The release criterion is **waived for the `v3.0.0` release tag only**. It is **not waived
for production payment enablement**, which remains fully blocked by GAP-06b.

### What this decision does and does not mean

This distinction is the entire substance of the exception, and collapsing it would be the
dishonesty the exception exists to prevent:

> **`v3.0.0` RELEASE** means: the platform is tagged as a coherent, tested, releasable
> version whose payment *infrastructure* — lifecycle, callback security, amount-tampering
> rejection, idempotency, refunds, and the financial reaction to all of it — has been
> genuinely proven end to end against a safe, isolated sandbox and real PostgreSQL.
>
> **PRODUCTION PAYMENT ENABLEMENT** means: real money can move. It is **not** included in
> this release, is **not** claimed by it, and remains an explicit, separate deployment
> prerequisite requiring real merchant credentials and target-host verification.

A deployment of `v3.0.0` to a production environment today would have **zero enabled
payment providers** and checkout would **fail closed**. That is the correct and intended
behaviour, and it is the safeguard that makes this exception acceptable rather than
reckless.

### Reasons the exception is acceptable

Each of these was verified in this release gate, not assumed:

1. **No production customer dataset exists.** V3 has never been deployed; there is no live
   user, order, or financial record at risk.
2. **No real merchant credentials exist** anywhere in this environment, and none were
   fabricated. There is nothing to leak or misuse.
3. **The application is fail-closed in production.** `SandboxPaymentProvider.isEnabled()`
   returns `false` under `NODE_ENV=production` unconditionally. It is the only registered
   provider. Production therefore has no payment path at all — refusal, never a fabricated
   success.
4. **The sandbox is isolated from production by construction**, on two independent
   conditions, with **no override flag of any kind** (see § Safeguards).
5. **No payment can be accidentally processed against the sandbox in production**, because
   the provider cannot be resolved there and the unauthenticated sandbox checkout route
   re-checks the same gate independently.
6. **The full payment lifecycle is covered by tests against real PostgreSQL**, not mocks
   and not an in-memory engine — `sandbox-payment-lifecycle.pg-spec.ts` (20 cases) and
   `payment-security.pg-spec.ts` (26 cases), both green in CI on the release commit.
7. **Callback verification is server-side.** `verify()` queries the gateway's own record
   and ignores callback parameters entirely; a forged success callback fails for the same
   structural reason it would against a real gateway.
8. **Amount tampering is rejected** — under-capture, over-capture, and post-intent order
   mutation are all proven non-exploitable.
9. **Duplicate callbacks are idempotent**, including genuinely simultaneous ones; a real
   second charge is detected and auto-refunded rather than silently absorbed.
10. **Refunds are concurrency-safe** — compare-and-swap on both the gateway side and the
    order side; one refund reference, never two.
11. **The financial integration is real.** A sandbox payment writes a genuine append-only
    ledger entry through the real event chain, and a refund produces a genuine ledger
    reversal — verified against the real `financial` schema whose append-only guarantee is
    enforced by PostgreSQL role grants, not application convention.

### Risks accepted

Stated plainly, because an exception that lists only mitigations is marketing:

| Risk | Assessment |
|---|---|
| **Money-unit semantics unexercised.** The sandbox transacts in Toman integers by fiat. A real Iranian gateway may expect Rial, or a different scaling. | **Real and unmitigated.** This is the single largest residual risk, and it is precisely why a real adapter must have its own sandbox-test cycle against the live API before activation. No amount of local simulation retires it. |
| **Field and error semantics unexercised.** Real gateway status codes, error taxonomies, and callback parameter names are unknown until an adapter is written against real docs. | **Real and unmitigated**, same reasoning. The `PaymentProvider` interface constrains the *shape* of an adapter, not the correctness of its mapping. |
| **No network failure modes exercised.** The sandbox makes no network call, so timeouts, partial responses, and gateway downtime are untested against real behaviour. | **Real.** Partially mitigated by the lifecycle's own idempotency and CAS properties, which are network-agnostic, but real timeout handling is adapter work. |
| **A reader could mistake "payment verified" for "production payment ready."** | **Mitigated by documentation discipline** — this exception, GAP-06's two-way split, and `V3_PAYMENT_SANDBOX.md`'s opening lines all state the distinction explicitly. |
| **Hosting grants unverified against a real provider.** | **Real, and independent of this exception.** Tracked separately; see § Production activation requirements. |

### Safeguards relied upon

The exception is acceptable *because* of these, and would not be acceptable without them:

1. **`NODE_ENV=production` is a hard stop with no override.** The former
   `PAYMENT_ALLOW_MOCK_GATEWAY=true` escape hatch was **removed rather than carried
   forward**. Verified explicitly: `payment-security.pg-spec.ts` asserts the gate stays
   closed under `PAYMENT_ALLOW_MOCK_GATEWAY=true`, `PAYMENT_ALLOW_SANDBOX=true`,
   `PAYMENT_ENVIRONMENT=sandbox`, and `PAYMENT_ENVIRONMENT=production` — every combination
   an operator might reach for.
2. **A second, independent condition** — `PAYMENT_ENVIRONMENT` must equal `sandbox`.
   Neither condition alone enables the provider.
3. **The registry refuses unknown provider keys** rather than falling back to another
   gateway, so a misconfigured `PAYMENT_DEFAULT_PROVIDER` cannot silently reroute payments.
4. **The unauthenticated sandbox checkout route re-checks the gate itself**, rather than
   assuming an earlier layer did.
5. **Structural test coverage**, not merely behavioural — the production gate is asserted
   directly against the provider's own logic rather than through a cached config snapshot
   that would make the assertion vacuous.

### Production activation requirements

**All of the following must be satisfied before real payment is enabled. None of them are
satisfied by this release.**

1. A **real gateway adapter** implementing `PaymentProvider`, written against the target
   gateway's real API documentation.
2. **Real merchant credentials**, held as deployment secrets — never committed.
3. **A sandbox-test cycle against the gateway's own sandbox environment**, exercising real
   money units, real field semantics, real error codes, and real network failure modes.
   The local simulator does not substitute for this.
4. `PAYMENT_DEFAULT_PROVIDER` repointed to the real adapter, with the sandbox provider
   confirmed unresolvable in that environment.
5. **A real target PostgreSQL host verified** with `database/scripts/financial-roles.sql` —
   the append-only ledger contract is currently proven only against CI's ephemeral
   container (`HOSTING_GRANTS = EXTERNAL_CONFIGURATION`), and PostgreSQL 15+'s revoked
   default `public` `CREATE` grant (PHASE4-03) must be handled on that host.
6. **An end-to-end live transaction verified in a real browser** against the gateway's
   sandbox, then a controlled real-money transaction, before general availability.
7. **GAP-06b formally closed in `V3_GAP_REGISTER.md`** on that evidence, and **this
   exception retired** — not merely allowed to lapse silently.

### Review condition

This exception is reviewed and must be re-decided if **any** of the following becomes true:

- A production deployment of `v3.0.0` is planned for real customers.
- Real merchant credentials become available (retire the exception; do not extend it).
- Any subsequent release (`v3.0.x`, `v3.1.0`, …) is proposed while GAP-06b is still open —
  the exception covers `v3.0.0` **only** and does not automatically extend to successors.
- The production gate's two-condition, no-override property is weakened in any way, by
  anyone, for any reason. That property is load-bearing for this entire decision.

---

## Index of exceptions

| ID | Title | Status | Scope | Underlying gap |
|---|---|---|---|---|
| EXC-001 | V3.0.0 Payment Sandbox Release Exception | ACTIVE | `v3.0.0` release only | GAP-06b |
