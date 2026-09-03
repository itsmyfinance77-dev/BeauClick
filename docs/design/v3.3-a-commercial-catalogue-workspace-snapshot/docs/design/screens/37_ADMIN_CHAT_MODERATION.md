# 37 — Admin Chat Moderation — V3.2-B

Prototype: `Prototype - Pro and Admin.dc.html` §18. Route family: `/v1/admin/chat/reports/*`. Capability: `bc_moderate_chat` — new, in `PRIVILEGED_CAPABILITIES`, held by `moderator` and `administrator` only. **Not** `platform_operator` — reading a private conversation and operating the platform are different privileges.

## Source read

`services/chat/src/chat-moderation.controller.ts`, `chat-moderation.service.ts`, `chat-access.service.ts`, `entities/chat.entities.ts`, ADR-032 §4, `V3.2_DECISION_REGISTER.md` (`V32-DEC-014`, `V32-DEC-015`), `V3_DOMAIN_BOUNDARIES.md`. Milestone commit `d2e11ea0f0f760c850997182f900748923e7418b`.

## The one entry point: a report id

There is no route taking a conversation id, a user id, a professional id, or a business id, and no search of any kind. **That absence is the control**, and the design mirrors it exactly: the prototype has no conversation browser and no user/id search box anywhere in this section. A moderator reaches a conversation only by opening a **report** from the queue.

## Queue — metadata only

Lists open (or filtered) reports: reason, status, `createdAt`, and — once decided — `decidedAt`/`decisionAction`. **No message body and no reporter's note appear in the list.** Oldest-first. Empty, loading, and retryable-error states designed alongside the populated queue.

## Report detail

Opening a report shows: the report's own fields (`reason`, the reporter's optional note, `status`, `createdAt`) and a **bounded window of at most 50 messages**, centred on the reported message (25 before / 25 after where the thread has room). Each message shows only `senderUserId` (rendered as a short raw id — «کاربر …» plus a truncated uuid fragment, never a resolved display name, avatar, or profile link — none of those fields exist on this read) and the erased-placeholder treatment where applicable. Reading a report is itself audited (`chat.report.read`); the design notes this as a disclosure record, not a user-facing claim.

## Access lifetime

An **open** report's window is readable indefinitely. A **decided** report's window stays readable for **30 days** after the decision, then access expires. An expired-access report, a report belonging to no accessible record, and an invented/foreign report id all produce the **same** refusal — a moderator holding a stale id learns nothing a moderator holding an invented one does not.

## Deciding

`outcome`: `upheld` or `rejected`. A **reason is mandatory** on every decision (min 3 characters) and is what lands in the immutable audit log — a `rejected` outcome needs one too, not only `upheld`. `action` is accepted only when `outcome = upheld`, defaults to `warn_sender` if omitted, and is refused/ignored on `rejected` (no punishment attached to a dismissed complaint). Three upheld actions exactly as implemented: `warn_sender`, `close_conversation` (permanently closes the conversation for sending — reading is untouched), `restrict_sender` (platform-wide chat sending restriction, derived from the report record itself, not a separate flag).

## Concurrent-decision conflict

Deciding is a compare-and-swap on `status = 'open'`; a second moderator deciding the same report after a colleague already has never silently overwrites the first verdict. **The server does not return a distinct conflict code for this** — the compare-and-swap loser gets the same generic missing/foreign/inaccessible-report refusal as any other unreachable id. The design copy is honest about that: "این گزارش دیگر برای تصمیم‌گیری در دسترس نیست. صف را تازه کنید." (this report is no longer available to decide; refresh the queue) — never a definite claim that a colleague already decided it, since the same message also covers an invented id, a foreign report, or one whose access window lapsed mid-session.

## What a moderator cannot do — structurally, not by convention

No browsing or searching conversations, no entry by user or conversation id, no sending, no impersonation, no editing or deleting a participant's message (deleting would destroy the evidence the decision rests on). None of these affordances exist anywhere in this section of the prototype.

## Status classification

| Item | Status |
|---|---|
| Queue (metadata-only), report detail (50-message window), decide (uphold/reject + 3 upheld actions + mandatory reason), concurrent-decision conflict, access-expiry at 30 days, indistinguishable missing/foreign/expired refusal | `IMPLEMENTED` |
| Broader staff-facing moderation tooling (bulk actions, saved filters) | `NOT DESIGNED — no contract for it` |

## Not built

Any conversation or user search, any route addressed by conversation/user/professional/business id, message edit/delete, sender impersonation, bulk moderation actions.
