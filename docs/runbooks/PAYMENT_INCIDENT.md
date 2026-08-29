# Runbook — payment incidents

## Status

Every code path below is implemented and covered by the real-PostgreSQL suite
(`payment-security.pg-spec.ts`, `payment-verification-contract.pg-spec.ts`).
None of it has met a real gateway: `GAP-06b` is open, no adapter exists, and
the sandbox is a local simulation. Treat the SQL as correct and the operational
timings as untested.

---

## The three incidents this platform is built to have

| Symptom | What it means | Money moved? |
|---|---|---|
| `unresolved` verifications | The gateway was not reached, or did not answer definitively | **Unknown** — the dangerous one |
| `duplicate_charge` refunds | A second real charge landed on an already-paid order | Yes, twice; second one auto-refunded |
| `amount_mismatch` failures | The gateway reported a success whose amount or currency disagreed | No — refused |

---

## 1. Unresolved verifications

**The one to alert on.** It means a payment whose result nobody knows.

It is invisible in every other signal by construction: the request returned
303, the customer got a result page, no exception was thrown, and **no event
was emitted**. Only the metric and the audit log show it.

```bash
curl -sH "authorization: Bearer $METRICS_AUTH_TOKEN" "$PUBLIC_API_BASE_URL/metrics" \
  | grep 'payment_verifications_total{outcome="unresolved"}'
```

### What the platform already did

Nothing — deliberately, and that is the correct behaviour. On an ambiguous
verification `applyVerification` returns before any write: the attempt stays
`initiated`, the intent stays `pending`, the order stays unpaid, and no
`PaymentSucceeded`/`PaymentFailed` is emitted. `PaymentFailed` would fan out to
five consumers and drive an append-only ledger entry that cannot be withdrawn.

Because nothing was written, the payment is **recoverable**: a later callback on
the same reference still settles it, with no manual repair.

### Find them

```sql
SELECT a.id, a.provider_reference, a.provider_key, i.order_id, i.amount_toman, a.created_at
  FROM payment.payment_attempts a
  JOIN payment.payment_intents i ON i.id = a.payment_intent_id
 WHERE a.status = 'initiated'
   AND a.created_at < now() - interval '30 minutes'
 ORDER BY a.created_at;
```

An attempt still `initiated` well past the intent TTL either never reached the
bank or hit this case. The audit log distinguishes them —
`payment.verification_unresolved` carries `cause: timeout` or the transport
error, plus the correlation id.

### Resolve them

**Ask the gateway. Never guess.**

The customer can simply return to the callback URL, and the platform will ask
again. Operationally you want that without the customer:

1. Reconcile against the gateway's own settlement report for the window.
2. For each reference the gateway says was PAID, replaying the callback
   server-to-server settles it correctly — verification is idempotent and the
   attempt CAS makes a double-settle impossible.
3. For each reference the gateway says was NOT paid, leave it. The intent
   expires and the customer retries.

Do **not** mark anything paid by hand.
`markPaid` is a compare-and-swap and the ledger is append-only; a manual
`UPDATE` bypasses the commission split, the settlement projection, the
notification, and the loyalty award, and there is no clean way back.

### If the rate is sustained

A handful is a bad network minute. A sustained rate is money moving with no
record of it. Escalate, and consider taking checkout offline —
`PAYMENT_DEFAULT_PROVIDER` pointing at nothing produces a Persian 503 at
checkout while the rest of the marketplace keeps working. That is why `payment`
is `required: false` in the readiness contract: pulling every instance would
also remove the pages that tell customers what is going on.

---

## 2. Duplicate charges

A second genuinely-paid gateway transaction landed on an order that was already
paid. The platform detects it (the attempt won its own CAS but `markPaid`
found the order already paid), refunds the second charge automatically, keyed
by the ATTEMPT so the order's one real payment is untouched, and logs
`DUPLICATE CHARGE detected` at error level.

```sql
SELECT r.id, r.order_id, r.amount_toman, r.status, r.provider_refund_reference, r.completed_at
  FROM payment.refunds r
 WHERE r.kind = 'duplicate_charge'
 ORDER BY r.id DESC;
```

- `status = 'succeeded'` — handled. The customer sees "به دلیل یک پرداخت
  تکراری، مبلغ دوم به‌صورت خودکار بازگردانده شد" and the money returns on the
  bank's own timeline.
- `status = 'manual_required'` — the gateway has no refund API. The money has to
  be returned through the bank's manual process. This is an honest outcome, not
  a failure.
- `status = 'failed'` — the refund call failed. Investigate; do not retry by
  inserting a second refund row. `requestKey` is deterministic per cause and
  the unique constraint is what stops a double refund.

A duplicate-charge refund deliberately does **not** reduce the order total or
reverse the commission: that money was outside the order's accounting entirely,
and the commission was correctly earned once.

---

## 3. Amount or currency mismatch

The gateway reported a SUCCESS whose amount or currency disagreed with what the
intent recorded before the customer left. Treated as a security event, not an
ordinary decline: the payment is refused, `failure_code = 'amount_mismatch'` is
stored, and `payment.amount_mismatch` is logged with both figures and both
currencies.

```sql
SELECT a.id, a.provider_reference, a.requested_amount_toman, a.verified_amount_toman, a.verified_at
  FROM payment.payment_attempts a
 WHERE a.failure_code = 'amount_mismatch'
 ORDER BY a.verified_at DESC;
```

Two distinguishable causes, and the audit record's `reportedCurrency` tells
them apart:

- **`reportedCurrency` is null** — the adapter did not state its unit. Refused
  by design (`QA-10`). This is an adapter bug, not an attack.
- **`reportedCurrency` differs, or the number differs** — the gateway captured
  something other than what was owed. **The rial/toman trap**: Iranian gateway
  APIs commonly denominate in rials, and 1 toman = 10 rials, so an adapter
  passing the gateway's figure straight through would settle a 1,000,000-toman
  order for 100,000 tomans and pass a bare numeric equality check. The unit
  mapping belongs in the adapter, and this check is what catches it.

The customer is told to contact support and is **not** invited to retry —
`isRetryableFailureReason` refuses both `amount_mismatch` and `unresolved`,
because retrying a payment that may already have succeeded is how somebody gets
charged twice.

If money did move, refund it deliberately through the gateway's own console and
record a compensating ledger entry. Do not delete anything: the ledger is
append-only by grant and the attempt row is the evidence.

---

## Tracing any of it

Every log line, every outbox row, and every error report from one request
carries the same correlation id, and it is returned to the client in the
`x-correlation-id` response header. A customer's support ticket with that
header is a complete trace.

```sql
SELECT event_type, payload, created_at
  FROM payment.outbox_events
 WHERE correlation_id = '<id>'
 ORDER BY created_at;
```

---

## What none of this covers

A real gateway. `GAP-06b` requires a selected adapter, merchant credentials, a
full lifecycle against the gateway's own sandbox, and one controlled real-money
transaction. Its error taxonomy, its callback source IPs, its settlement
reporting, and its refund semantics are all unknown, and the throttling policy
on the callback route is calibrated against the sandbox's volume
characteristics rather than a real gateway's — `V3_SECURITY_MODEL.md` records
that it must be re-derived from measurement.
