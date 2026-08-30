# BeauClick Design — V3.2-B Internal Chat Sync

Exported: 2026-08-30
Repository: `marabi766/BeauClick`, `v3/` scope. Chat implementation read at milestone commit `d2e11ea0f0f760c850997182f900748923e7418b` (CI run 33314468705, all green); repository `master` separately at `63f9a8b9e76e5eb73faec8e3933c413a0f6fba56` (PR workflow only).
No repository code changed; no commit made against `marabi766/BeauClick`.

## This pass

Synchronised all customer, professional/business, and admin chat surfaces against the real `@beauclick/chat-contract` and `chat` service implementation (ADR-031, ADR-032).

- **New specs:** `docs/design/screens/36_INTERNAL_CHAT.md`, `docs/design/screens/37_ADMIN_CHAT_MODERATION.md`.
- **New prototype sections:** `Prototype - Customer.dc.html` §18 (inbox/thread, professional and business counterparties, all refusal/read-only states, report flow, block/unblock, erased placeholder, notification entry point); `Prototype - Pro and Admin.dc.html` §17 (professional/business inbox, owner+active-manager access, seller-side read-only states) and §18 (admin report queue and detail, report-id-only entry, 50-message window, uphold/reject with three actions, concurrent-decision conflict).
- Preserved exactly: immutable historical counterparty (no picker), booking eligibility rule, 90-day send window, directional/mutual blocking with no blocker disclosure, seven report reasons and rate limits, business-inbox owner+manager-only access, admin moderation's report-id-only boundary.
- Confirmed absent from both prototypes: attachments, typing/presence/delivery receipts, push/SMS/email, realtime transport, message editing/participant deletion, group chat, AI context integration.

## Top-level content inventory

- `Prototype - Customer.dc.html` — full customer prototype, §18 added this pass.
- `Prototype - Pro and Admin.dc.html` — full pro/admin prototype, §17–§18 added this pass.
- `Design Language.dc.html`, `Recreation - V3 Today.dc.html` — earlier baseline artifacts.
- `BeauClick-Mobile-Preview-Standalone.html` — standalone mobile export.
- `docs/design/screens/` — 37 screen specs, including new `36_INTERNAL_CHAT.md` and `37_ADMIN_CHAT_MODERATION.md`.
- `docs/design/V3.1.0_FINAL_DESIGN_HANDOFF.md` — handoff through §28 (this pass).
- `github.md` — sync record, baseline, screen map, sync history.
- `support.js`, `doc-page.js` — runtime files required by the `.dc.html` prototypes.
- `fonts/` — self-hosted Vazirmatn and display fonts.

## Correction pass (same day)

Two verified implementation mismatches fixed after re-audit against `d2e11ea0f0f7`:

1. **Business counterparty display.** `chat-contract.ts` returns only `counterpartyType`/`counterpartyId` — no name/avatar field. A professional resolves via the existing public provider route; a business does not (no `@Public` business-detail route, businesses absent from search). Replaced invented salon names («سالن بهار», «آتلیه سارا محمدی») in `Prototype - Customer.dc.html` §18 with the neutral label «کسب‌وکار BeauClick» + type badge, and marked named-business rendering `BACKEND CONTRACT REQUIRED` in `36_INTERNAL_CHAT.md` and the prototype.
2. **Moderation decision race — concurrent-decision CAS protection with a generic unavailable response.** `chat-moderation.service.ts`/`.controller.ts` return the same generic `NotFoundOrNotYoursException` to the compare-and-swap loser as to any missing/foreign/expired report id — there is no distinct "already decided" response. Replaced the definite "قبلاً توسط همکار دیگری تصمیم‌گیری شده" copy in `Prototype - Pro and Admin.dc.html` §18 and `37_ADMIN_CHAT_MODERATION.md` with a generic "no longer available, refresh the queue" state.

Files touched (this correction pass): `docs/design/screens/36_INTERNAL_CHAT.md`, `docs/design/screens/37_ADMIN_CHAT_MODERATION.md`, `Prototype - Customer.dc.html` §18, `Prototype - Pro and Admin.dc.html` §18, `docs/design/V3.1.0_FINAL_DESIGN_HANDOFF.md` §28, `github.md`, this file.

## Unresolved gates (this pass)

**Legal:** approved customer-facing chat disclosure/consent copy — no placeholder wording invented.
**Product:** V3.3-C staff role matrix, which owns any broader or practitioner-specific business-inbox access — explicitly deferred, not designed here.
**Backend:** none blocking the implemented neutral-label Chat surface. Optional real business-name rendering requires a public business-summary contract.
