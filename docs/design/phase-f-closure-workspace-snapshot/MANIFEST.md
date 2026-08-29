# BeauClick Design — Phase F Closure Snapshot

Exported: 2026-08-29
Repository baseline: `marabi766/BeauClick` @ `226b14a441f1dfc1c4ee42b9831e51232d5ee14b` (CI run 33238002176, green)
`origin/master` not written to. This snapshot is design-workspace output only — no repository code was changed to produce it.

## Scope of this pass
Final closure sync on the payment-result screen (`/checkout/result`) after implementation: reclassify the four retryable failure reasons from BACKEND CONTRACT REQUIRED to IMPLEMENTED against the shipped `POST /v1/orders/:id/payment/retry` contract; reclassify `expired` to the tracked product gap `EXPIRED-REBOOK`; confirm every other Phase F design decision matches the implementation. Professional/admin prototype unchanged.

## v2 correction (this export)
The first closure pass left `16_CHECKOUT_RESULT.md` with several sections still describing the pre-implementation state (heading-focus "not in code today", the receipt-error/missing-orderId/unauthenticated edge-case table framed as future design rather than shipped behaviour, and residual `IMPLEMENTABLE NOW` labels on now-shipped items). All are corrected to `IMPLEMENTED`, each citing the exact `page.tsx` behaviour and the `checkout-result.spec.tsx` test that pins it, in `master@226b14a`. Historical mentions in §25 of the handoff and in `github.md`'s prior sync entries are left as-is (clearly past-tense, superseded by §26 / the newest sync entry) — history is not rewritten.

## Status matrix — six outcomes

| status | tone | retry | notes |
|---|---|---|---|
| succeeded | success | — | |
| replayed | success | — | |
| failed | error | see reason matrix | |
| refunded | warning | — | tone changed error→warning, Phase F design decision |
| duplicate_refunded | success | — | |
| unresolved | warning | — | copy corrected, no automatic-resolution promise |

## Status matrix — eight failure reasons (status=failed)

| reason | retry | state |
|---|---|---|
| cancelled_by_user | yes | IMPLEMENTED — wired to `POST /v1/orders/:id/payment/retry` |
| declined | yes | IMPLEMENTED |
| not_completed | yes | IMPLEMENTED |
| gateway_error | yes | IMPLEMENTED — copy also corrected (no refund promise) |
| expired | no | `EXPIRED-REBOOK` — tracked product gap, not backend |
| unknown_reference | no | by design (unreasonable to retry) |
| amount_mismatch | no | by design (security event) |
| unresolved | no | by design (double-charge risk); server refuses with `verification_pending` if attempted |

## Confirmations
- The retry backend gap from the prior design pass is **closed**: `POST /v1/orders/:id/payment/retry` is order-scoped, empty body, no `intentId` anywhere in the contract, response is `{ redirectUrl }` only.
- `EXPIRED-REBOOK` remains **open** as a product/booking decision — no rebooking action was invented for it.
- No implementation/design mismatch was found; corrected `unresolved`/`gateway_error` copy, `refunded` warning tone, heading focus, missing-order/unauthenticated states, safe-return login path, and receipt-fetch retry all match the shipped page.
- URL parameters (`status`, `reason`, `orderId`) remain presentation inputs only; receipt and payment truth come from the authenticated API.
- No repository code was changed. `origin/master` unchanged.

## Contents
- `docs/design/screens/` — all 34 screen specs, including the closure-updated `16_CHECKOUT_RESULT.md`.
- `docs/design/V3.1.0_FINAL_DESIGN_HANDOFF.md` — full handoff through §26 (Phase F closure).
- `Prototype - Customer.dc.html` — §16 updated with the implemented retry interaction (three states) and reclassified matrix.
- `Prototype - Pro and Admin.dc.html` — unchanged this pass.
- `Design Language.dc.html`, `Recreation - V3 Today.dc.html` — earlier baseline artifacts.
- `fonts/` — self-hosted Vazirmatn (and Peyda/Anjoman display fonts).
- `github.md` — sync record, baseline, screen map, sync history.

## Open items (unchanged by this pass, out of scope)
- `EXPIRED-REBOOK` — safe re-checkout path for an expired payment window; product/booking decision.
- Legal content, font delivery ratification, business-owner erasure outcome — business decisions carried over from Phase E.
- `GAP-06b` (gateway selection), cancellation/refund policy — business decisions, out of scope for this surface.
- `GAP-11` (SMS vendor) — external configuration, unrelated to this pass.

Both `.dc.html` prototypes load independently and require no other file in this archive except `support.js`, `doc-page.js`, and `fonts/`.
