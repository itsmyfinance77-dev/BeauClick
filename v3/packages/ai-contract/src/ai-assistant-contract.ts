/**
 * The AI assistant contract, in the half that both sides can hold.
 *
 * ## Why this is its own package
 *
 * The same reasoning `@beauclick/payment-contract` records, applied to a
 * second surface. `services/ai` owns the domain and is a NestJS module full of
 * TypeORM entities; the assistant page is a Next.js client bundle. The page
 * needs exactly four things from the domain — which provider states exist,
 * which refusal reasons exist, which message roles exist, and what the size
 * and pagination limits are — and importing the domain to get them would drag
 * `@nestjs/common`, `typeorm`, and every entity into a browser bundle.
 *
 * The alternative is what a frontend does by default: keep its own copy of the
 * vocabulary as string literals. That works right up until the two disagree,
 * and the failure mode is silent. A refusal reason the server can emit that
 * the page has no branch for renders as a blank error. A character limit the
 * page enforces at 2000 while the server refuses at 1000 produces a rejection
 * the user cannot see coming. **Two policies that must agree, maintained
 * separately, are one policy plus a bug waiting for a release.**
 *
 * ## What this does NOT do
 *
 * **It does not authorize anything, and it does not enforce anything.** Every
 * limit here is also enforced server-side from the server's own inputs — the
 * page's copy exists so a user gets a counter and a disabled button instead of
 * a round trip that fails. A client that lies about a length, a role, or a
 * quota gets a refusal from a server that never asked it.
 *
 * **It carries no provider identity.** There is no vendor name here, no model
 * name, no endpoint, and no key. `AiProviderState` describes what KIND of
 * thing answered, which is the only provider fact a browser is entitled to.
 */

// ---------------------------------------------------------------------------
// Provider state
// ---------------------------------------------------------------------------

/**
 * What kind of thing produced an assistant reply, as far as the browser is
 * told.
 *
 * This is the honesty surface, and it is the reason the field exists at all.
 * ADR-029 §4: a deterministic local assistant and a frontier language model
 * produce the same shape of confident Persian paragraph, and no user, operator,
 * or dashboard can tell them apart unless something says so. So something says
 * so, in the response body, on every message.
 *
 * `simulated` — a deterministic local assistant composed this reply from
 * already-curated platform data. It is a real implementation and a correct one;
 * it is not a language model, and it must never be presented as one.
 *
 * `external` — a real external provider answered. Reserved. **Nothing in the
 * V3.2-A sandbox milestone can produce this value**, because no external
 * provider is registered.
 *
 * `unavailable` — no provider could answer. The reply the user is looking at is
 * a platform-authored refusal, not an assistant's answer.
 *
 * Deliberately NOT the same enum as the readiness surface's `ReadinessState`.
 * That one answers an operator's question about a deployment; this one answers
 * a reader's question about the sentence in front of them, and collapsing the
 * two would put `not_configured` in a chat bubble.
 */
export const AI_PROVIDER_STATES = ['simulated', 'external', 'unavailable'] as const;

export type AiProviderState = (typeof AI_PROVIDER_STATES)[number];

export function isAiProviderState(value: unknown): value is AiProviderState {
  return typeof value === 'string' && (AI_PROVIDER_STATES as readonly string[]).includes(value);
}

/**
 * True when the reply the user is reading did not come from a real language
 * model, and the interface should say so rather than let them assume otherwise.
 *
 * `unavailable` counts: a refusal is not an assistant answer either.
 */
export function isSimulatedAssistantReply(state: AiProviderState): boolean {
  return state !== 'external';
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every reason the server will decline to accept or answer a message, as a
 * closed set.
 *
 * Closed for the reason the payment failure vocabulary is closed: the
 * alternative is an internal state name, a provider code, or an exception
 * message reaching a browser. A new distinction is a deliberate edit here plus
 * the Persian copy that goes with it.
 *
 * Deliberately coarse where the user's next action is the same, and precise
 * where it differs. `quota_exhausted` and `consent_required` are separate
 * because one means "come back tomorrow" and the other means "press a button";
 * `unsafe_request` covers every input-screening refusal as one reason, because
 * telling a prober exactly which pattern matched is telling them how to
 * rephrase.
 */
export const AI_REFUSAL_REASONS = [
  /** The one-time acceptance has not been recorded for this user. */
  'consent_required',
  /** The daily accepted-message allowance is spent. Carries the exact reset instant. */
  'quota_exhausted',
  /**
   * The message was screened out before any provider was invoked.
   *
   * Covers prompt-injection attempts and requests for another person's private
   * data, deliberately as ONE reason. Distinguishing them would tell somebody
   * probing the boundary which of their two techniques was detected.
   */
  'unsafe_request',
  /** The message is empty, or longer than `AI_MAX_INPUT_CHARACTERS`. */
  'message_too_long',
  /** The conversation is closed. A closed conversation is never reopened — start a new one. */
  'conversation_closed',
  /**
   * The per-user retained-conversation cap is reached and cannot be satisfied
   * without destroying an ACTIVE conversation, which the platform will not do.
   */
  'conversation_limit_reached',
  /** No provider could answer: none is configured, or the selected one failed. */
  'assistant_unavailable',
] as const;

export type AiRefusalReason = (typeof AI_REFUSAL_REASONS)[number];

export function isAiRefusalReason(value: unknown): value is AiRefusalReason {
  return typeof value === 'string' && (AI_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * Whether the user can fix this themselves right now.
 *
 * Drives one thing in the interface: whether the composer stays open. Three of
 * the seven reasons are the user's to resolve — shorten the message, accept the
 * terms, start a new conversation. The other four are a wait or a limit, and
 * leaving the composer enabled for them invites a user to retype the same
 * message into the same refusal.
 */
export function isUserResolvableRefusal(reason: AiRefusalReason): boolean {
  return reason === 'consent_required' || reason === 'message_too_long' || reason === 'conversation_closed';
}

// ---------------------------------------------------------------------------
// Conversations and messages
// ---------------------------------------------------------------------------

/**
 * `active` accepts messages; `closed` is read-only forever.
 *
 * There is no third state and no transition back. `V32-DEC-002`: a closed
 * session is never reopened, and continuing produces a new session. Modelling
 * a `reopened` state would create a conversation whose inactivity horizon has
 * already fired once, which is precisely the unbounded-context shape the
 * bounded-session decision exists to prevent.
 */
export const AI_CONVERSATION_STATUSES = ['active', 'closed'] as const;

export type AiConversationStatus = (typeof AI_CONVERSATION_STATUSES)[number];

export const AI_MESSAGE_ROLES = ['customer', 'assistant'] as const;

export type AiMessageRole = (typeof AI_MESSAGE_ROLES)[number];

/**
 * Why a conversation is closed.
 *
 * `inactivity` is the 24-hour horizon firing. `superseded` is the user starting
 * a new conversation while this one was still active — recorded distinctly
 * because the two look identical in a list and mean different things to a user
 * wondering why their thread stopped accepting messages.
 */
export const AI_CLOSURE_REASONS = ['inactivity', 'superseded'] as const;

export type AiClosureReason = (typeof AI_CLOSURE_REASONS)[number];

export function isAiClosureReason(value: unknown): value is AiClosureReason {
  return typeof value === 'string' && (AI_CLOSURE_REASONS as readonly string[]).includes(value);
}

/**
 * What a recommendation can point at.
 *
 * Two kinds, and both are public catalogue records. There is deliberately no
 * `slot`, no `booking`, and no `order`: `V32-DEC-004` prohibits a preselected
 * booking slot, and the way that prohibition is kept is by having no type able
 * to express one.
 */
export const AI_RECOMMENDATION_TARGETS = ['professional', 'service'] as const;

export type AiRecommendationTarget = (typeof AI_RECOMMENDATION_TARGETS)[number];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The maximum length of one customer message, in Unicode CODE POINTS.
 *
 * Code points, not UTF-16 units and not bytes, and the distinction is not
 * pedantry in a Persian product. `"سلام".length` and `[..."سلام"].length` agree;
 * a string containing an emoji or a rare CJK character does not, because those
 * are surrogate pairs and `.length` counts each half. A limit expressed in
 * UTF-16 units silently halves for some users and not others.
 *
 * Both sides count the same way — see `aiInputLength` below, which is exported
 * precisely so the page's character counter and the server's refusal cannot
 * disagree about what "1000 characters" means.
 *
 * 1000 is a product boundary rather than a storage one. A question a discovery
 * assistant can usefully answer fits in a paragraph; a field that invites an
 * essay invites a medical history, and `journey`'s 500-character notes cap
 * already records that this platform must not become a medical-record system.
 */
export const AI_MAX_INPUT_CHARACTERS = 1000;

/** The maximum length of one assistant reply, in code points. Enforced on provider output. */
export const AI_MAX_REPLY_CHARACTERS = 2000;

/**
 * The most recommendations accepted from a single provider response.
 *
 * A cap on what is ACCEPTED, not on what is requested. A provider returning
 * fifty candidates has its response rejected outright rather than truncated to
 * the first four, because silently taking a prefix of an over-long list is how
 * a misbehaving provider's output gets normalised into looking correct.
 */
export const AI_MAX_RECOMMENDATIONS_PER_REPLY = 4;

/**
 * How many accepted customer messages one user may send per Tehran calendar
 * day (`V32-DEC-008`).
 *
 * Shared with the browser so the interface can show a remaining count. **The
 * limit is enforced in PostgreSQL, atomically with the message insert**, and
 * this constant does not participate in that enforcement — it is here so the
 * page can render "۳ پیام باقی مانده" without inventing a second number.
 */
export const AI_DAILY_MESSAGE_QUOTA = 20;

/** Retained conversations per customer (`V32-DEC-002`). */
export const AI_MAX_RETAINED_CONVERSATIONS = 20;

/** Hours of inactivity after which an active conversation is closed (`V32-DEC-002`). */
export const AI_INACTIVITY_CLOSE_HOURS = 24;

/** Days a conversation is retained before the sweep destroys it (`V32-DEC-002`, `V32-DEC-007`). */
export const AI_RETENTION_DAYS = 30;

/** Maximum conversations returned in one page. */
export const AI_MAX_PAGE_SIZE = 50;

export const AI_DEFAULT_PAGE_SIZE = 20;

/**
 * The length of a customer message, counted the way both sides count it.
 *
 * Normalised to NFC first. Persian text arrives from browsers in more than one
 * normalisation form — the same visible word can be composed or decomposed —
 * and counting the raw string would make the limit depend on which keyboard
 * the user typed with.
 */
export function aiInputLength(text: string): number {
  return [...text.normalize('NFC')].length;
}

/** Whether a message is an acceptable length. The server applies the same test to its own input. */
export function isAcceptableAiInput(text: string): boolean {
  const length = aiInputLength(text.trim());
  return length > 0 && length <= AI_MAX_INPUT_CHARACTERS;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * The identifier of the acceptance the platform records (`V32-DEC-006`).
 *
 * A KEY, not a version number, and the difference is the point. A version
 * number implies a sequence, a re-prompt on increment, and a withdrawal path —
 * which is the platform-wide versioned consent system scheduled at V3.3-E and
 * explicitly out of scope here. This is one named acceptance, recorded once.
 *
 * `sandbox` is in the key on purpose: it names the acceptance that was actually
 * recorded, under the disclosure that actually existed at the time. The final
 * customer-facing copy is pending legal review, so an acceptance gathered now
 * must not be indistinguishable from one gathered against approved wording.
 */
export const AI_CONSENT_CONTRACT_KEY = 'ai_assistant_sandbox_v1';

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** One recommendation as the browser receives it. Public catalogue fields only. */
export interface AiRecommendationView {
  readonly id: string;
  readonly targetType: AiRecommendationTarget;
  readonly targetId: string;
  readonly displayName: string;
  readonly position: number;
}

/** One message as the browser receives it. */
export interface AiMessageView {
  readonly id: string;
  readonly role: AiMessageRole;
  readonly body: string;
  /** Present on assistant messages only. Null on the customer's own. */
  readonly providerState: AiProviderState | null;
  readonly sequence: number;
  readonly createdAt: string;
  readonly recommendations: readonly AiRecommendationView[];
}

/** One conversation in a list. Deliberately carries no message bodies. */
export interface AiConversationSummary {
  readonly id: string;
  readonly status: AiConversationStatus;
  readonly closureReason: AiClosureReason | null;
  readonly messageCount: number;
  readonly startedAt: string;
  readonly lastActivityAt: string;
}

/**
 * The remaining allowance, and exactly when it resets.
 *
 * `resetsAt` is an absolute instant rather than a duration, and it is the
 * Tehran calendar boundary — not "in 6 hours". A duration computed server-side
 * is stale by the time it renders, and a client counting down to a moment it
 * calculated in its own timezone counts down to the wrong one.
 */
export interface AiQuotaView {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetsAt: string;
}
