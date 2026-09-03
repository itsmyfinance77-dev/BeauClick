# 35 — AI Assistant (Customer) — V3.2-A deterministic sandbox

Prototype: `Prototype - Customer.dc.html` §17. Route family: `/v1/me/ai/*`. Capability: `bc_use_ai_assistant` (customer only — no professional mode exists).

## Source read

`packages/ai-contract/src/ai-assistant-contract.ts`, `services/ai/src/ai.controller.ts`, `ai.exceptions.ts`, `ai-consent.service.ts`, `ai-conversation.service.ts`, `ai-quota.service.ts`, `providers/ai-provider.interface.ts`, `providers/deterministic-assistant.provider.ts`, `safety/ai-input-safety.ts`, ADR-029, ADR-030, `V3.2_DECISION_REGISTER.md` §A (`V32-DEC-001`–`009`, all `DECIDED 2026-08-29`). Baseline `649dad5`.

## Scope

Customer mode only (`V32-DEC-001`). No professional assistant, no operator content-management screen, no human chat, no CRM, no production-provider configuration. Every field in the prototype maps to a real response field; nothing is invented.

## Honesty contract

Every assistant reply carries `providerState` (`simulated` | `external` | `unavailable`); only `simulated` occurs in this milestone. The deterministic provider appends `AI_ASSISTANT_DISCLOSURE` to every reply it produces — with recommendations, without recommendations, and when recommendations were partially dropped alike. **Correction (this pass):** §17 previously omitted the disclosure on the zero-recommendation example; every assistant-message example in §17 now visibly shows it inline in the reply, not as a separate annotation. This is an engineering-level honesty statement (ADR-029 §3), not the legal disclosure. The pre-consent screen shows a separate sandbox-disclosure sentence, marked `LEGAL REVIEW REQUIRED` — final approved copy is pending legal (`V32-DEC-006`) and this design does not claim approval.

## Consent (`V32-DEC-006`)

One-time, idempotent, no request body. States designed: pre-consent (disclosure + accept), accepted (no revocation control — none exists), loading, retryable fetch error, and the `consent_required` refusal with a direct "بپذیرید" path. No preference or withdrawal UI — unsupported by the API.

## Conversation lifecycle (`V32-DEC-002`, `V32-DEC-003`)

Bounded sessions: max 20 retained, 24h inactivity auto-close, 30-day retention, oldest **closed** conversation evicted at the cap (never an active one — refusal instead). Closed is permanent; continuing starts a new conversation. States designed: active, closed/inactivity, closed/superseded (visibly distinct copy, same list badge shape), empty list, paginated list (`nextCursor`), `conversation_limit_reached` refusal, permanent-delete confirmation, and the indistinguishable "no longer available" 404 shared by deleted/foreign/retention-expired conversations — no restore affordance anywhere.

**Correction (this pass):** `AiConversationSummary` carries only `id`, `status`, `closureReason`, `messageCount`, `startedAt`, `lastActivityAt` — no title, summary, or generated label. List rows and the active-conversation header were redesigned to derive their text only from these fields (start time, last-activity time, message count, status) — no invented conversation titles remain anywhere in §17.

## Messages and quota (`V32-DEC-008`)

1,000-char input cap / 2,000-char reply cap, both counted in Unicode code points (`aiInputLength`) — the same function the browser counter and the server refusal use. 20 accepted messages per Tehran calendar day; refused messages consume none. States designed: live counter, disabled/enabled/sending composer, near-limit counter, quota-exhausted composer with the exact Tehran-reset copy, and the `role="log" aria-live="polite"` transcript with focus-on-send / focus-on-reply behavior.

## Refusals (`AI_REFUSAL_REASONS`, exact server strings)

All seven designed as individual cards with the literal Persian server copy, and each marked composer-available or not per `isUserResolvableRefusal`: `consent_required`, `message_too_long`, `conversation_closed` stay resolvable; `quota_exhausted`, `unsafe_request`, `conversation_limit_reached`, `assistant_unavailable` are not, and no fake retry action is offered for them. `unsafe_request` covers both injection and private-data-request server-side reasons as one browser-facing reason — the prototype does not distinguish them, matching the contract's intentional coarseness.

## Recommendations (`AI_RECOMMENDATION_TARGETS`, max 4)

**Correction (this pass):** the browser-facing `AiRecommendationView` and the assistant's reply prose are two separate contracts, previously conflated. `AiRecommendationView` carries only `id`, `targetType` (`professional` | `service`), `targetId`, `displayName`, `position` — no city, specialties, verified badge, rating, review count, or price. Cards in §17 now render only `displayName` and a `targetType` label; no enrichment fields are shown, since no implemented public API for enrichment was cited. `DeterministicAssistantProvider.describe()`'s prose may mention more detail in the reply text itself, but that prose is not a source for card fields — the card and the sentence are not parsed into each other.

Both target types are shown as separate examples in §17 (a professional card, a service card), with a note that the deterministic provider currently emits `professional` recommendations in practice even though the browser contract supports both. Link cards go to the existing profile/service pages — no booking, no slot selection, no favorites mutation. Zero-recommendation state (disclosure-bearing assistant text only, no cards) and the silent-partial-drop behavior (re-verification removes a stale id without any visible customer-facing notice) are both designed.

## Privacy and security boundaries (`V32-DEC-009`)

No operator/admin route exists for AI content — absent by design, not merely hidden. The design has no admin surface for this feature and the Pro/Admin prototype is untouched. No internal prompt, detection phrase, or provider diagnostic is ever shown.

## Accessibility

Full RTL, logical focus order (list → conversation → composer), live-region announcements on send/reply/refusal/quota (not per keystroke), 44px icon-button targets with accessible names, reduced-motion (no bubble/typing animation), long-Persian-text wrap and 200% zoom reflow to a single column.

## Status classification

| Item | Status |
|---|---|
| Full `/v1/me/ai/*` flow, quota, lifecycle, safety pipeline, deterministic replies | `IMPLEMENTED` |
| Final disclosure/consent copy | `LEGAL REVIEW REQUIRED` |
| Real external provider, credentials, region, spend ceiling | `EXTERNAL CONFIGURATION REQUIRED` |
| Public review-style author label for future text inputs | `PRODUCT DECISION REQUIRED` (unrelated existing gap, not reopened here) |
| Professional assistant mode, operator content access, pre-filled action links, streaming tokens | `DESIGN ONLY — FUTURE PHASE` (several are structurally absent by decision, not merely deferred) |

## Not built

Professional mode, operator/support read access to conversation content, pre-filled booking action links, streaming responses, any consent-preferences or withdrawal control.
