# ADR-028 — The ambiguous verification outcome, and readiness as distinct from health

**Status:** Accepted (V3.1 Phase F, 2026-08-29)
**Supersedes:** nothing. Extends ADR-006 (payment provider abstraction).

---

## Context

Two questions surfaced while building the provider-neutral half of Phase F, and
they turn out to be the same question asked at two different layers:

> **What do you say when you do not know?**

### 1. A verification that never got an answer

`VerifyOutcome` was `succeeded | failed`. Every adapter has to pick one of
those, for every call, including the calls where the gateway accepted the
connection and never replied.

Both answers are wrong, and they are not symmetrically wrong. `succeeded`
settles an order nobody confirmed. `failed` is worse in practice:

- it writes a terminal `payment_attempts.status` and a terminal
  `payment_intents.status`, so the attempt can never be resolved later;
- it emits `PaymentFailed`, which fans out to five consumers;
- it drives an append-only ledger entry (ADR-009 / ADR-017) that cannot be
  withdrawn;
- and it tells a customer whose card may well have been charged that no money
  moved — after which they retry, and are charged twice.

A network timeout does not tell you a payment failed. It tells you nothing.

### 2. A deployment that is healthy and is not a marketplace

`GET /health` reported `status: ok` when the database answered. That is the
right shape for a liveness probe and it cannot express the fact that actually
governs this phase: **whether a deployment is talking to real things or to
stand-ins.**

Every stand-in in this platform is deliberate, tested, and correct for the
environment it was built for — `SandboxPaymentProvider`, `InMemorySearchEngine`,
`LocalObjectStorageDriver`, `NullSmsProvider`. A deployment running all four is
perfectly healthy. Nobody can log in, nothing can be searched, no money can
move, and every uploaded file disappears with the container.

V2 shipped a "local development only" payment stand-in whose status was a
sentence in the UI with no mechanism behind it, and a readiness audit found it
still reachable. `NotificationChannelPort.providerVerified`,
`SmsProvider.deliversExternally`, and `MediaService.describeDriver().durable`
are three separate answers to that lesson, one dependency at a time, with no
shared vocabulary and no single place to read them.

---

## Decision

### 1. `VerifyOutcome` gains `unknown`, and `unknown` writes nothing

An adapter MUST return `unknown` for a request timeout, a connection failure, a
gateway 5xx, and any response it cannot parse into a definite outcome. It may
return `failed` only when the gateway itself said the transaction did not
succeed.

`applyVerification` returns before any write for `unknown`. The attempt stays
`initiated`, the intent stays `pending`, no event is emitted, and the outcome
is reported as `unresolved`.

**No schema change.** `unknown` is the absence of a write, which is precisely
why it needs none — and why the state it leaves behind is one a later callback
can still resolve. That recoverability is the property that makes "write
nothing" the right answer rather than merely the cautious one, and it is
asserted directly: an unresolved verification followed by an honest one settles
the payment with no manual repair.

The caller imposes the deadline (`PAYMENT_VERIFY_TIMEOUT_MS`, default 15s)
rather than each adapter, because `prepareVerification` runs inside a request a
customer's browser is waiting on and the port's contract does not require an
adapter to impose one.

The public reason for an `unknown` is **always** `unresolved`, never derived
from whatever code the adapter attached. An adapter reporting `outcome:
'unknown'` with `failureCode: 'gateway_5xx'` would otherwise narrow to
`gateway_error`, whose copy promises the customer that any money taken will
come back — a promise nobody can make about a payment whose outcome is unknown.

### 2. Readiness is a separate endpoint with a five-state vocabulary

`GET /health` stays exactly as it was: liveness, unchanged in shape, because an
orchestrator already depends on it.

`GET /health/ready` reports each dependency as one of:

| State | Meaning |
|---|---|
| `not_configured` | Nothing is set. The dependency is off. |
| **`simulated`** | A local stand-in is serving. Not an error — the fact that a green check does not mean what a reader assumes. |
| `configured` | Real settings present; not probed on this request. |
| `reachable` / `unreachable` | Probed on THIS request, and answered or did not. |

`configured` and `reachable` are deliberately distinct: object storage and a
payment gateway must not be probed on every scrape, so claiming they are
reachable would claim something nobody checked.

### 3. `productionVerified` is a separate axis, and no code may set it

A dependency can be configured, reachable, and still never have been exercised
against the real external service under production conditions. `reachable` says
a socket opened; it says nothing about whether one real OTP has arrived on a
real phone or one real rial has settled.

`EXTERNAL_VERIFICATION_LEDGER` holds one row per such dependency, naming the
open gap (`GAP-06b`, `GAP-11`, `HOSTING_GRANTS`, `HOSTING`, `OPS-04`,
`THROTTLE-STORE`) and the evidence that would close it. Every row is `false`,
and a test asserts that every row is `false`.

**There is deliberately no setter.** Flipping one to `true` is an edit to that
file by a person holding evidence — never a side effect of a probe, a
configuration check, or a successful sandbox run.

### 4. Readiness gates traffic; it does not gate honesty

`required: true` only for `database` and `ledger`. Search degrades to a visibly
reduced result page, an upload fails while browsing works, and checkout fails
while the rest of the marketplace runs.

A readiness probe that failed because SMS has no vendor would take every
instance out of rotation for a condition no restart can fix — turning a known,
recorded, non-urgent gap into a total outage, and removing the pages that tell
customers what is going on.

---

## Consequences

**Accepted.**

- **A third state to handle everywhere a verification outcome is consumed.**
  `checkout.service.ts`, the redirect contract, and the result page each gained
  a branch. Worth it: the alternative is a two-word vocabulary that is
  guaranteed to be wrong for a whole class of real events.
- **An `unresolved` payment needs an operational answer, not just a code one.**
  A customer returning to the callback resolves it automatically; a customer
  who does not leaves an attempt open until the intent expires. There is no
  reconciliation sweep — [PAYMENT_INCIDENT.md](../../../runbooks/PAYMENT_INCIDENT.md)
  documents the manual procedure, and a sweep against the gateway's settlement
  report is the right thing to build once a real gateway exists and its
  reporting semantics are known. Building it now would be guessing at them.
- **A ledger that must be edited by hand is a ledger that can go stale.**
  Mitigated by making it serve the readiness endpoint, so it is read on every
  deploy rather than only when someone opens the document.
- **The readiness endpoint is public and rate-limit exempt**, because an
  orchestrator's probe carries no session and must never be throttled out of
  rotation. Everything it emits is therefore an enum, a boolean, or a gap id —
  no host, credential, endpoint, or connection string, asserted by a test that
  serialises the report and searches it for the process's real configuration.
  The configuration problem list is withheld in production for the same reason:
  it names variables, origins, and drivers, which is a configuration map.

**Rejected alternatives.**

- *Keep two outcomes and treat a timeout as `failed`, then compensate.* This is
  V2's "paid but unconfirmable" pattern, which V3 removed by making the payment
  and the confirmation atomic. Reintroducing a compensating path for a case
  that can simply not be written is a step backwards.
- *Retry the verification inside the request.* A retry against a gateway that
  is timing out extends the customer's wait to a multiple of the deadline, and
  a gateway in trouble is in trouble for every request at once.
- *One endpoint reporting everything.* Liveness and readiness answer different
  questions for different callers, and merging them means either an orchestrator
  restarting a process because SMS has no vendor, or a readiness probe that
  cannot say what is simulated.
- *Boolean `productionVerified` inferred from configuration.* This is the
  entire failure mode the field exists to prevent. Configuration is what a
  deployment claims; verification is what somebody checked.

---

## Cross-references

- `ADR-006` — the payment provider abstraction this extends.
- `ADR-009` / `ADR-017` — why an entry written on a guess cannot be withdrawn.
- `V3.1_EXTERNAL_ENABLEMENT_STRATEGY.md` §4 — the gate `EXTERNAL_VERIFICATION_LEDGER` mirrors.
- `V3.1_PHASE_F_IMPLEMENTATION.md` — what this phase built and what it did not.
