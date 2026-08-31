# 36 — Internal Chat (Customer, Professional, Business) — V3.2-B

Prototype: `Prototype - Customer.dc.html` §18 (customer). `Prototype - Pro and Admin.dc.html` §17 (professional/business inbox). Route family: `/v1/chat/*`. Capability: `bc_use_chat` — held by `customer`, `professional`, and `business` (the `business` grant is load-bearing: without it a salon owner is refused at the capability guard before membership is ever checked).

## Source read

`packages/chat-contract/src/chat-contract.ts`, `services/chat/src/chat.controller.ts`, `chat.exceptions.ts`, `chat.service.ts`, `chat-access.service.ts`, `chat-retention.service.ts`, `chat-subject-data.contract.ts`, `entities/chat.entities.ts`, `ports/chat.ports.ts`, `database/migrations/chat/20260830500001_create_chat_schema.sql`, ADR-031 (domain/counterparty/eligibility), ADR-032 (privacy/abuse/moderation — companion, see `37_ADMIN_CHAT_MODERATION.md`), `V3.2_DECISION_REGISTER.md` (`V32-DEC-010`–`012`). Milestone commit `d2e11ea0f0f760c850997182f900748923e7418b`; repository master at time of sync `63f9a8b9e76e5eb73faec8e3933c413a0f6fba56` (adds only the PR workflow — no chat code there).

## Scope

Participant surfaces only: customer inbox/thread, professional inbox/thread, business inbox/thread (owner + active managers). Moderation is a separate capability and a separate spec (`37`). Polling is the implemented transport; the UI does not expose it as technical language.

## Counterparty — immutable, never chosen

A conversation's counterparty is copied once, at creation, from `commerce.orders.seller_party_type/seller_party_id` **as it was at the qualifying booking's checkout** — never recomputed from current salon affiliation. **The customer never picks between "message the professional" and "message the salon"** (`V32-DEC-010`); the design has no counterparty picker anywhere. A business conversation's counterparty is the business id — no practitioner identity reaches the customer's screen, and no screen implies the booked practitioner personally reads a salon-owned thread.

**Counterparty display — contract-accurate, not assumed.** `ChatConversationSummary` carries only `counterpartyType`/`counterpartyId` — no display name, avatar, or profile field of any kind (`chat-contract.ts`, deliberately: "those come from the provider catalogue on a separate read"). A **professional** counterparty's name is resolvable today via the existing public provider route (`GET /v1/providers/:id`). A **business** counterparty is not: the current business controller has no `@Public` business-detail route and businesses do not appear in search. The design therefore renders a business row/header as a neutral **«کسب‌وکار BeauClick»** label plus the business-type badge — never an invented salon name — and marks named-business rendering as **BACKEND CONTRACT REQUIRED: public business summary lookup**. No avatar, professional name, or profile link appears on a business conversation regardless.

A professional changing salons changes nothing about existing conversations — they stay with the business actually paid at the time.

## Eligibility (`V32-DEC-011`)

Qualifying booking statuses: `confirmed`, `completed`, `no_show`. `cancelled` qualifies **only** when `booking_history` proves the booking previously reached `confirmed` — a `pending → cancelled` hold never qualifies. `pending` and `expired` never qualify. A refund never revokes eligibility once prior confirmation is proven. Multiple qualifying bookings with the same counterparty collapse into **one** conversation. Starting a conversation is only ever reachable from a qualifying booking or an existing thread in the inbox — the design has no free-text "start a chat" entry point that accepts an arbitrary professional or business id.

## Send window (`V32-DEC-012`)

Sending closes **90 days** after the latest qualifying booking's `slot_end` (absolute UTC, no calendar rounding). **Read persists past that** — history stays visible, subject only to retention (24 months from the last message) and erasure. A new qualifying booking reopens sending by moving the maximum; there is no separate "reactivate" action.

## Business inbox access

Limited to the **business owner** and **active managers**. Ordinary `staff` — including the booked practitioner when their role is only `staff` — get no inbox access; broader/practitioner-specific access is deferred to V3.3-C and not designed here. Access is evaluated per request, not cached: a manager deactivated this morning loses the inbox on their next request.

## Read state

A monotonic watermark per participant (`lastReadSequence`), not a per-message receipt — correct for a business thread with more than one legitimate reader. Unread counts are server-computed and pushed, never decremented locally.

## Blocking

Directional record (`blocker`, `blocked`), **mutual effect** — sending is refused for both sides while a block exists in either direction. The blocked party is told only the generic "sending unavailable" refusal, identical to what the blocker sees; the design never distinguishes "you blocked them" from "they blocked you" in blocked-party copy. Only the blocker may unblock. History stays fully readable through a block.

## Reporting a message

Anchored to one message id. Seven reasons exactly as implemented: `harassment`, `spam`, `scam_or_fraud`, `explicit`, `personal_data`, `off_platform_payment`, `other`. Optional note, capped at **500 Unicode code points**. At most **one open report per (reporter, conversation)** — a second attempt while one is open is refused with `report_already_open`, not silently merged or queued. At most **5 new reports per reporter per rolling 24 hours** (`report_rate_limited`). Filing a report does not itself close, hide, or mark the conversation in the reporter's own inbox — a moderator decision does.

## Refusal vocabulary (`ChatRefusalReason`, exact server strings)

| Reason | Resolvable by editing? | Composer / action state |
|---|---|---|
| `not_eligible` | No | No qualifying relationship — same answer for a nonexistent counterparty, an unbooked one, or a never-confirmed one |
| `send_window_closed` | No | 90-day window closed; read-only until a new qualifying booking |
| `blocked` | No | Never reveals direction |
| `conversation_closed` | No | Moderator closed for sending; read-only permanently |
| `sender_restricted` | No | Platform-wide sending restriction on the account |
| `message_too_long` | **Yes** | Empty or over 2,000 code points — only refusal the composer stays enabled for |
| `rate_limited` | No | Per-minute (20) or per-day (300) send throttle |
| `report_already_open` | No | One open report already exists on this conversation |
| `report_rate_limited` | No | 5 new reports/24h reached |

## Erasure and deletion (`V32-DEC-013`)

An erased sender's messages render as a neutral placeholder — no excerpt, no length, no reconstructable fragment — attributed to «کاربر حذف‌شده» (deleted user), distinct from an empty message (which cannot exist). Surviving counterparty messages are unaffected and keep their sequence position, so a thread with an erased participant still reads in order with visible gaps.

## Loading, pagination, retry, offline

Inbox: cursor-paginated, newest activity first. Thread: keyset-paginated on message `sequence` (never offset — a retention sweep or erasure between pages must not silently skip a row). Every list and thread has an explicit loading skeleton, a retryable network-error state, and an empty state (no conversations; no messages before the first). A failed send is visibly retryable and never silently dropped.

## Notification / unread entry points

The existing notification list (`18_NOTIFICATIONS.md`) and the shared shell's unread badge are the entry points into chat; no separate real-time indicator (no typing, no presence, no delivery receipt) is designed, per the excluded-scope list below.

## Explicitly not designed

Attachments/images/files/voice, typing indicators, presence/online status, delivery receipts, push/SMS/email delivery, realtime transport (SSE/WebSocket), message editing, participant-initiated deletion, group chat, AI summaries or reply assistance, chat content entering AI context (`chat` exposes no context port — ADR-032 §5).

## Status classification

| Item | Status |
|---|---|
| Full `/v1/chat/*` participant flow: start, list, read, send, mark-read, unread count, block/unblock, report | `IMPLEMENTED` |
| Business owner + active-manager inbox access; ordinary-staff exclusion | `IMPLEMENTED` |
| Practitioner-specific business-inbox access | `DEFERRED — V3.3-C role matrix` |
| Approved customer-facing chat disclosure/consent copy | `LEGAL REVIEW REQUIRED` (no placeholder wording invented) |
| Attachments, push delivery, realtime transport, group chat | `DESIGN EXCLUDED — not in this milestone` |
