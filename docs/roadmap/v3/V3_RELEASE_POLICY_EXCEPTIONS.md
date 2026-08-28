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

## EXC-002 — V3.0.x / V3.1.x Payment Sandbox Release Exception

| Field | Value |
|---|---|
| **Exception ID** | EXC-002 |
| **Title** | V3.0.x / V3.1.x Payment Sandbox Release Exception |
| **Decision date** | 2026-08-28 |
| **Status** | ACTIVE |
| **Applies to** | **Every release in the `v3.0.x` and `v3.1.x` lines while GAP-06b remains open.** Retrospectively covers `v3.0.1` (released without a covering exception — `R31-04`); covers `v3.1.0` and any `v3.1.x` successor |
| **Does NOT apply to** | `v3.0.0` (covered by EXC-001, which remains historical and unchanged), `v3.2.0` and beyond, and **production payment enablement in any version** |
| **Underlying gap** | `GAP-06b` — real production payment gateway — **OPEN / EXTERNAL_CONFIGURATION** |
| **Resolves** | `R31-04` — "EXC-001 does not cover `v3.0.1` and does not extend to `v3.1.x`" |
| **Owner / approving authority** | Project owner (repository owner), by explicit written release-policy direction dated 2026-08-28 selecting Option A of `V3.1_RELEASE_STRATEGY.md` §5 |
| **Retires when** | `v3.2.0`, **or earlier** if GAP-06b is genuinely closed before then — see § Retirement condition |

### Why this is a new exception rather than an amendment to EXC-001

EXC-001 states *"Applies to: The `v3.0.0` release only"*, and its own Review condition fires
when *"any subsequent release (`v3.0.x`, `v3.1.0`, …) is proposed while GAP-06b is still
open — the exception covers `v3.0.0` **only** and does not automatically extend to
successors."*

That clause did what it was written to do: it fired. `v3.0.1` shipped anyway, recording
`EXC-001 = STILL ACTIVE, unchanged and unextended` — a statement accurate about EXC-001 and,
read against the scope clause, an admission that `v3.0.1` shipped uncovered. The same
condition fires again at `v3.1.0`.

**EXC-001 is deliberately left untouched.** Amending a published exception's scope after the
fact would rewrite the record of what was decided for `v3.0.0` and would make its scope
clause retrospectively meaningless — the precise drift this document exists to prevent. A
new, separately-decided exception keeps both facts visible: what was decided then, and what
is being decided now.

### The unmet criterion

Restated rather than referenced, because an exception that delegates its own subject to
another document cannot be audited on its own terms:

`V3_IMPLEMENTATION_ROADMAP.md`'s Phase 2 acceptance criteria requires the core booking loop
to run *"against a real (even sandbox) payment gateway"*, and `V3_GAP_REGISTER.md`'s
original GAP-06 wording calls a real gateway an *"explicit precondition for a real V3 launch,
not merely a code gap."* A locally-simulated bank does not satisfy that criterion as written.

### The decision

Every release in the `v3.0.x` and `v3.1.x` lines **may be released** with:

- **Sandbox payment lifecycle — VERIFIED** (GAP-06a, RESOLVED)
- **Production payment gateway — NOT CONFIGURED** (GAP-06b, **OPEN / EXTERNAL_CONFIGURATION**)

The release criterion is **waived for those release tags only**. It is **not waived for
production payment enablement**, which remains fully blocked by GAP-06b.

### What this decision does and does not mean

Stated as three explicit assertions, because collapsing them is the dishonesty this
exception exists to prevent:

> 1. **`GAP-06b` remains OPEN.** This exception does not close it, narrow it, downgrade it,
>    or re-classify it. `V3_GAP_REGISTER.md` remains the authority on gap status and
>    continues to carry GAP-06b as OPEN / EXTERNAL_CONFIGURATION, production-blocking.
>
> 2. **EXC-002 does NOT mean the real payment gateway exists.** No adapter has been written.
>    No merchant credentials exist in this environment and none were fabricated. No real
>    money has moved or can move.
>
> 3. **EXC-002 only permits release of the specified V3 release lines using the verified
>    sandbox payment environment.** It permits a *tag*, not a *deployment that takes money*.

A deployment of any covered release to a production environment today would have **zero
enabled payment providers** and checkout would **fail closed**. That is the intended
behaviour, and it is the safeguard that makes this exception acceptable rather than reckless.

### Reasons the exception is acceptable

**Every item below was re-verified against the `v3.1.0` release candidate on 2026-08-28.
None was carried forward from EXC-001 on trust.** Evidence class is named where it matters:
`code` (read in tracked source), `CI` (green on the release commit's code tree), `DB`
(observed in a real PostgreSQL database), `browser` (observed in a real browser this pass).

1. **No production customer dataset exists.** V3 has never been deployed; there is no live
   user, order, or financial record at risk. *(re-confirmed)*
2. **No real merchant credentials exist** anywhere in this environment, and none were
   fabricated. A repository-wide search for merchant, terminal, and gateway credential keys
   returns only documentation and comments. There is nothing to leak or misuse. *(code)*
3. **The application is fail-closed in production.** `SandboxPaymentProvider.isEnabled()`
   returns `false` under `NODE_ENV=production` unconditionally, on the first evaluated line,
   before any other condition. It remains the **only** registered provider —
   `payment.module.ts` provides exactly `[sandbox]`. Production therefore has no payment
   path at all: refusal, never a fabricated success. *(code, CI)*
4. **The sandbox is isolated from production by construction**, on two independent AND-ed
   conditions, with **no override flag of any kind**. *(code, CI)*
5. **No payment can be accidentally processed against the sandbox in production**, because
   the provider cannot be resolved there and the unauthenticated sandbox checkout route
   re-checks the same gate independently. *(code)*
6. **The full payment lifecycle is covered against real PostgreSQL**, not mocks and not an
   in-memory engine — `sandbox-payment-lifecycle.pg-spec.ts` (18 cases) and
   `payment-security.pg-spec.ts` (26 cases), inside a suite of **450 real-database cases,
   0 skipped**, green in CI on the release commit's code tree and re-run locally this pass.
   *(CI, DB)*
7. **Callback verification is server-side.** `verify()` queries the gateway's own record;
   callback parameters identify the transaction and never decide its outcome. *(code, DB)*
8. **The verifying provider is read from trusted server state, not from the request.**
   `prepareVerification` resolves the provider from `attempt.providerKey` rather than the
   callback's path parameter — the `R31-17` §3 hardening, **new since EXC-001**. Proven
   adversarially this pass: a callback to `/v1/payments/callback/mock` carrying a genuine
   `sandbox` reference returns **404** and verifies nothing. *(code, browser)*
9. **Amount tampering is rejected** — under-capture, over-capture, and post-intent order
   mutation are all proven non-exploitable; a mismatch is recorded as
   `payment.amount_mismatch` rather than silently absorbed. *(code, CI)*
10. **Currency is validated, not assumed.** The intent's currency is compared against the
    provider-reported `paidCurrency`, and the sandbox declares `IRT` explicitly rather than
    by omission. *(code)*
11. **Duplicate callbacks are idempotent.** Re-verified end to end this pass: replaying the
    exact callback of a settled payment returned `status=replayed`, and the ledger row count
    for that order stayed at **2**. *(browser, DB)*
12. **Financial effects are idempotent and real.** A sandbox payment writes genuine
    append-only ledger entries through the real event chain — observed this pass as
    commission 45,000 + receivable 255,000 on a 300,000 Toman order, **exactly one row
    each** — against the real `financial` schema whose append-only guarantee is enforced by
    PostgreSQL role grants, not application convention. *(browser, DB)*
13. **Refunds are concurrency-safe** — compare-and-swap on both the gateway side and the
    order side; one refund reference, never two. A genuine duplicate charge is detected and
    auto-refunded rather than silently absorbed. *(code, CI)*
14. **The sandbox is unmistakably identifiable as a sandbox.** Its provider key is literally
    `sandbox`, every reference it mints is prefixed `SBX-`, and its checkout page carries a
    permanent banner: «درگاه پرداخت آزمایشی (Sandbox) — این صفحه شبیه‌ساز است و هیچ تراکنش
    واقعی انجام نمی‌شود». *(code, browser)*
15. **`PAYMENT_ALLOW_MOCK_GATEWAY` does not exist.** The escape hatch was removed in Phase 5
    rather than carried forward, and no equivalent was reintroduced. It survives only in
    comments and in the regression test that asserts its absence. *(code, CI)*

**Evidence note, recorded so this list cannot be read as stronger than it is.** The
`browser` evidence above comes from a **hands-off** run against the rebuilt production
bundle — one click on «پرداخت موفق», with no manual navigation of the return leg. That
distinction matters: the *assisted* browser runs that preceded this gate concealed `R31-20`
(the gateway page never navigated to the callback at all), which was found and fixed at this
gate. Nothing in this exception rests on an assisted run.

### Risks accepted

Stated plainly, because an exception that lists only mitigations is marketing. These are
**unchanged in substance from EXC-001 and re-affirmed rather than diminished** — covering one
more release line does not make an unexercised integration more exercised.

| Risk | Assessment |
|---|---|
| **Money-unit semantics unexercised.** The sandbox transacts in Toman integers by fiat. A real Iranian gateway may expect Rial, or a different scaling. | **Real and unmitigated.** Still the single largest residual risk. Extending coverage across two release lines does not reduce it; only a real adapter's own sandbox-test cycle against the live API retires it. |
| **Field and error semantics unexercised.** Real gateway status codes, error taxonomies, and callback parameter names are unknown until an adapter is written against real docs. | **Real and unmitigated**, same reasoning. The `PaymentProvider` interface constrains an adapter's *shape*, not the correctness of its mapping. |
| **No network failure modes exercised.** The sandbox makes no network call, so timeouts, partial responses, and gateway downtime are untested against real behaviour. | **Real.** Partially mitigated by idempotency and CAS properties that are network-agnostic; real timeout handling remains adapter work. |
| **A reader could mistake "payment verified" for "production payment ready."** | **Mitigated by documentation discipline** — this exception's three explicit assertions above, GAP-06's two-way split, and `V3_PAYMENT_SANDBOX.md`'s opening lines. |
| **A longer-lived exception is easier to stop re-reading than a single-release one.** EXC-001 covered one tag; EXC-002 covers two release lines. | **Real, and new to this exception.** Mitigated structurally: the retirement condition is a dated hard stop at `v3.2.0` requiring a *new* governance decision rather than a renewal, and the review conditions fire on each covered release. This risk is why the retirement condition is dated rather than open-ended. |
| **Hosting grants unverified against a real provider.** | **Real, and independent of this exception.** Tracked separately as `HOSTING_GRANTS`; see § Production activation requirements. |

### Safeguards relied upon

The exception is acceptable *because* of these, and would not be acceptable without them.
All ten were re-verified on 2026-08-28 against the `v3.1.0` release candidate.

1. **Production payment cannot use sandbox.** `SandboxPaymentProvider.isEnabled()` returns
   `false` whenever `NODE_ENV=production`, and it is the only registered provider — so
   production resolves no payment provider at all. **VERIFIED** *(code, CI)*
2. **`NODE_ENV=production` is an unconditional payment safety gate.** It is checked first
   and returns immediately; no later condition can re-open it. **VERIFIED** *(code, CI)*
3. **No environment variable can override the production hard stop.**
   `payment-security.pg-spec.ts` asserts the gate stays closed under
   `PAYMENT_ALLOW_MOCK_GATEWAY=true`, `PAYMENT_ALLOW_SANDBOX=true`,
   `PAYMENT_ENVIRONMENT=sandbox`, and `PAYMENT_ENVIRONMENT=production` — every combination
   an operator might reach for — asserted against the provider's own logic rather than
   through a cached config snapshot that would make the assertion vacuous. **VERIFIED**
   *(code, CI)*
4. **Payment verification uses trusted server-side provider state.** `prepareVerification`
   reads `attempt.providerKey`, never the callback's path parameter. **VERIFIED**
   *(code, browser — `/callback/mock` with a real `sandbox` reference returns 404)*
5. **Sandbox payment is explicitly identifiable as sandbox.** Provider key `sandbox`,
   `SBX-` reference prefix, permanent Persian sandbox banner on the checkout page.
   **VERIFIED** *(code, browser)*
6. **Amount and currency validation remains enforced.** The expected amount is taken from
   the intent and compared against the provider-reported paid amount and currency;
   mismatches are recorded and fail. **VERIFIED** *(code, CI)*
7. **Callback provider spoofing is rejected.** A crafted callback naming a different
   provider cannot verify a payment, and a forged reference is indistinguishable from an
   unpaid one — both 404, so nothing can be enumerated. **VERIFIED** *(browser)*
8. **Payment callbacks are idempotent.** A replayed callback returns `replayed` without
   re-calling the gateway and without writing. **VERIFIED** *(browser, DB)*
9. **Financial ledger effects are idempotent.** Replaying a settled payment's callback
   produced no additional ledger rows. **VERIFIED** *(browser, DB)*
10. **GAP-06b remains visible in the gap register.** Carried as OPEN /
    EXTERNAL_CONFIGURATION, production-blocking, with this exception recorded against it
    rather than in place of it. **VERIFIED** *(`V3_GAP_REGISTER.md`)*

Additionally, and unchanged from EXC-001: the registry **refuses unknown provider keys**
rather than falling back to another gateway, and the unauthenticated sandbox checkout route
**re-checks the gate itself** rather than assuming an earlier layer did.

### Production activation requirements

**All of the following must be satisfied before real payment is enabled. None of them are
satisfied by any release this exception covers.** Restated in full rather than
cross-referenced, so this exception can be audited without reading EXC-001.

1. A **real gateway adapter** implementing `PaymentProvider`, written against the target
   gateway's real API documentation.
2. **Real merchant credentials**, held as deployment secrets — never committed.
3. **A sandbox-test cycle against the gateway's own sandbox environment**, exercising real
   money units, real field semantics, real error codes, and real network failure modes. The
   local simulator does not substitute for this.
4. `PAYMENT_DEFAULT_PROVIDER` repointed to the real adapter, with the sandbox provider
   confirmed unresolvable in that environment.
5. **A real target PostgreSQL host verified** with `database/scripts/financial-roles.sql`
   and `database/scripts/admin-audit-roles.sql` — the append-only ledger contract and the
   admin audit log's non-application ownership are currently proven only against ephemeral
   CI containers (`HOSTING_GRANTS = EXTERNAL_CONFIGURATION`), and PostgreSQL 15+'s revoked
   default `public` `CREATE` grant (`PHASE4-03`) must be handled on that host.
6. **An end-to-end live transaction verified in a real browser** against the gateway's
   sandbox, then a controlled real-money transaction, before general availability.
7. **GAP-06b formally closed in `V3_GAP_REGISTER.md`** on that evidence, and **this
   exception retired** — not merely allowed to lapse silently.

### Review condition

This exception is reviewed and must be re-decided if **any** of the following becomes true:

- A production deployment of any covered release is planned for real customers.
- Real merchant credentials become available — **retire the exception; do not extend it**.
- A release **outside** the `v3.0.x` and `v3.1.x` lines is proposed while GAP-06b is still
  open. This exception covers those two lines **only** and does not automatically extend to
  `v3.2.x` or any successor line. *(This is the same clause that fired at `v3.0.1` and
  `v3.1.0`. It is meant to fire.)*
- The production gate's two-condition, no-override property is weakened in any way, by
  anyone, for any reason. **That property is load-bearing for this entire decision**, and
  re-reading it is the point of every review.
- The trusted-server-state provider resolution in `prepareVerification` is weakened, or a
  callback path parameter is again allowed to select the verifying provider.

### Retirement condition

**EXC-002 retires at `v3.2.0`, or earlier if GAP-06b is genuinely closed before then.**

- **If GAP-06b is closed first** — a real adapter exists, real credentials are configured,
  and the § Production activation requirements checklist is fully satisfied and verified —
  then EXC-002 is retired on that evidence, together with EXC-001, and GAP-06b is closed in
  `V3_GAP_REGISTER.md`.
- **If GAP-06b is still open at `v3.2.0`**, this exception **does not silently extend**.
  Coverage stops at the `v3.1.x` line. A new, explicit governance decision — a new exception
  carrying its own re-verification of every item in § Reasons the exception is acceptable
  and § Safeguards relied upon — is required before any `v3.2.x` tag.

Letting an exception lapse by convention is the specific failure mode this document exists
to prevent; it is what produced `R31-04`, and repeating it would waste the correction.

---

## Index of exceptions

| ID | Title | Status | Scope | Underlying gap |
|---|---|---|---|---|
| EXC-001 | V3.0.0 Payment Sandbox Release Exception | ACTIVE | `v3.0.0` release only | GAP-06b |
| EXC-002 | V3.0.x / V3.1.x Payment Sandbox Release Exception | ACTIVE | every `v3.0.x` and `v3.1.x` release while GAP-06b is open (retrospectively covers `v3.0.1`) | GAP-06b |
