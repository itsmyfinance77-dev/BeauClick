# V3 Payment Sandbox

**What this is:** a deterministic, isolated, local simulation of an external payment gateway, so the entire payment lifecycle — and every security property around it — is built and proven before a real Iranian gateway adapter exists.

**What this is NOT:** production payment. `SandboxPaymentProvider` cannot run in production, by construction (§5). GAP-06's production half remains **OPEN / EXTERNAL_CONFIGURATION**: no real gateway adapter exists, no merchant credentials exist in this environment, and none were fabricated.

---

## 1. Why this is an evolution, not a new provider

`MockGatewayProvider` (Phase 2) already *was* a sandbox by every meaningful measure: it kept its own gateway-side table, `verify()` performed a genuine server-side lookup against that table and ignored callback parameters entirely, it redirected to a checkout page standing in for one a gateway would host, its refunds were idempotent, and it gated itself shut in production.

Building a second `SandboxPaymentProvider` alongside it would have produced two payment simulators, two gateway tables, two checkout pages, and two test suites proving the same properties — which is precisely the duplication to avoid. So the mock was **renamed and extended** into the sandbox, and the genuinely missing capabilities were added.

## 2. Provider contract

Unchanged. `SandboxPaymentProvider implements PaymentProvider` — the exact interface a future real adapter implements. Adding ZarinPal (or any gateway) is a new class implementing the same interface plus one registry entry; no commerce, booking, financial, or controller code changes. Two interface rules every adapter must honour, and the sandbox does:

1. **`verify()` must talk to the gateway.** It may never derive success from callback parameters — those are attacker-controlled. The callback says *which* transaction to ask about; the gateway says whether it was paid.
2. **`verify()` must report the amount the gateway actually captured**, so the caller can compare against what was owed. An adapter returning only success/failure makes amount-tampering undetectable.

## 3. Sandbox behaviour

| Stage | Behaviour |
|---|---|
| Initiate | Mints `SBX-<random>`, inserts a real `payment.sandbox_transactions` row (`pending`) recording amount, currency, `order_id`, `payment_intent_id`, returns a redirect URL to the sandbox checkout |
| Decide | The simulated bank's decision point — `success` / `failure` / `cancel`, compare-and-swapped on `outcome='pending'` |
| Verify | Genuine server-side lookup of the gateway's own row; reports **its** amount, never the caller's |
| Refund | Idempotent, CAS on `refund_reference IS NULL` |

### Outcomes

`pending` → `paid` | `declined` | `cancelled`, enforced by a DB CHECK constraint.

`declined` and `cancelled` are **deliberately distinct**. A bank refusing a card and a customer abandoning checkout are different events, produce different failure codes (`declined` vs `cancelled_by_user`), and a support engineer reproducing a ticket must be able to choose between them. The previous mock conflated both behind a single button.

A **settlement reference is assigned on the paid path and nowhere else** — it is proof money moved, so a declined or cancelled transaction carrying one would let a forged verification look legitimate.

## 4. Sandbox checkout

`/sandbox-gateway?reference=…&callback=…` — Persian, RTL, labelled unmistakably as a simulator, offering the three decisions explicitly. It behaves exactly as a real gateway's page does: it records a decision **on the gateway side**, then returns the browser to the merchant's callback URL carrying **only the transaction reference**. It never tells the API the outcome. That is what makes tampering with the return URL pointless.

The gateway reference is rendered **verbatim**, never through `toPersianDigits` — an opaque machine identifier a customer may read back to support must stay transcribable and matchable against the gateway's records. Persian digits are for quantities a human reads, not identifiers a human copies.

## 5. Production boundary — the security core

`isEnabled()` requires **two independent conditions**, and fails closed:

```
NODE_ENV !== 'production'   AND   PAYMENT_ENVIRONMENT === 'sandbox'
```

`NODE_ENV=production` is a **hard stop with no override of any kind**. The previous `PAYMENT_ALLOW_MOCK_GATEWAY=true` escape hatch was **removed rather than carried forward** — a simulated bank that a single environment variable can switch on in production is exactly the hazard this gate exists to prevent, and it is the same class of hazard a V2 readiness audit found in that version's Cash-on-Delivery stand-in (whose "local development only" status was UI text with no mechanism behind it).

The registry consults `isEnabled()` on every resolution, and the `@Public()` sandbox checkout endpoint re-checks it independently — that route is reachable without authentication (a real gateway's page carries no BeauClick session), so it must refuse on its own rather than assume an earlier layer did.

Consequence worth stating plainly: **in production today there are zero enabled payment providers**, so checkout fails closed. That is the correct behaviour when no real gateway is configured — refusal, never a fabricated success.

## 6. Security properties

| Property | Mechanism |
|---|---|
| Forged callback | `verify()` asks the gateway's own table; a callback claiming `Status=OK` on a `pending` transaction fails with `not_completed` |
| Amount tampering | The caller compares the gateway's reported amount against the intent's recorded amount; any mismatch is never success, and is audit-logged as `payment.amount_mismatch` |
| Unknown transaction | `unknown_reference`, indistinguishable in shape from other failures |
| Unrecognised decision | Refused (`unknown_decision`) — never coerced to a default. The old `{paid?: boolean}` shape treated anything but explicit `false` as paid, so a typo'd field name meant a successful payment |
| Replayed callback | Order `markPaid` is a CAS on `status='pending'`; a genuine second charge is detected and auto-refunded |
| Concurrent decision | CAS on `outcome='pending'` — exactly one winner |
| Concurrent refund | CAS on `refund_reference IS NULL` — one reference, never two |

## 7. Idempotency

Every step is idempotent by a real database constraint or CAS, never by a preceding read:

- Order creation: `UNIQUE(source_type, source_id)`
- Payment attempt reuse: partial unique index preventing a second live attempt per intent
- Order paid: CAS on `status='pending'`
- Ledger entries: `UNIQUE(entry_type, reference_type, reference_id)`
- Gateway decision / refund: CAS, as above

## 8. Financial integration

The sandbox exercises the **real** financial service on its own append-only connection — there is no fake financial path. A successful sandbox payment produces a real commission + receivable pair summing exactly to the amount paid; a refund produces a real reversal at the originally-captured rate; a declined or cancelled payment produces **no ledger entry at all**. All asserted against real PostgreSQL in `sandbox-payment-lifecycle.pg-spec.ts`.

## 9. Test coverage

- `sandbox-payment-lifecycle.pg-spec.ts` — initiation books, all three decision paths, cancel-vs-decline distinction, decision CAS under real concurrency, refund idempotency/concurrency/invalid cases, checkout endpoint refusal semantics, financial consequence of each path.
- `payment-security.pg-spec.ts` — the adversarial suite (forged callback, amount tampering in both directions, duplicate and concurrent callbacks, replayed refunds, the production gate's full matrix). Deliberately not duplicated in the lifecycle suite.

## 10. Known limitations

1. **This is not a real gateway.** No real HTTP call, no real bank, no real money. Money-unit and field semantics of any actual Iranian gateway remain unexercised — the specific risk a real adapter must be tested against.
2. **Partial refunds are supported by commerce and the ledger, but the sandbox's own gateway-side record models a single refund reference.** Commerce/ledger partial-refund behaviour is covered by `financial-integrity.pg-spec.ts`; the sandbox does not simulate a gateway that tracks multiple partial refund references.
3. **No network-failure simulation.** Timeouts, gateway 5xx, and partial-response handling are not simulated; a real adapter will need its own coverage for those.
4. **Deterministic, not adversarial, by design.** The sandbox does exactly what QA asks it to. It does not model a hostile or flaky gateway.

## 11. Configuration

```
PAYMENT_DEFAULT_PROVIDER=sandbox
PAYMENT_ENVIRONMENT=sandbox
PAYMENT_SANDBOX_CHECKOUT_URL=http://localhost:3100/sandbox-gateway
```

`PAYMENT_ENVIRONMENT` defaults to `sandbox` outside production, so a developer configures nothing to run locally. A real deployment sets it to `production` **and** registers a real adapter — at which point the sandbox is inert regardless.
