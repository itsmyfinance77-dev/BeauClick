/**
 * The internal-chat contract, in the half that both sides can hold.
 *
 * The third package of this shape, after `@beauclick/payment-contract` and
 * `@beauclick/ai-contract`, and for the same reason each of those records: the
 * page needs a handful of vocabularies and limits from the domain, and importing
 * the domain to get them would drag `@nestjs/common`, `typeorm`, and every
 * entity into a browser bundle. The alternative — the page keeping its own
 * string literals — works until the two disagree, and the failure is silent.
 *
 * ## What is deliberately NOT here
 *
 * **No attachment type, field, or limit.** Attachments are out of the V3.2-B
 * milestone entirely (`CHAT-ATTACHMENT-STORAGE`), and the omission is total on
 * purpose: an always-empty `attachments: []` in `ChatMessageView` would be a
 * promise a client codes against, and removing it later would be a breaking
 * change to undo something that never worked. Adding attachments is a new field
 * plus a `MessageSent` v2, which is the correct amount of friction.
 *
 * **No counterparty display name, avatar, or profile field.** Those come from
 * the provider catalogue on a separate read. Putting them here would make this
 * package a second place the catalogue's public shape is defined.
 *
 * **No typing, presence, or delivery state.** None exists. A delivery receipt
 * under polling would mean "the recipient's browser polled", which is not what a
 * reader would understand it to mean.
 */

// ---------------------------------------------------------------------------
// Parties and participants
// ---------------------------------------------------------------------------

/**
 * Who the customer is talking to.
 *
 * Reuses `commerce.orders`' existing two-value seller-party vocabulary rather
 * than inventing a second one — the conversation's counterparty is literally
 * copied from that snapshot.
 *
 * **The customer never chooses between these** (`V32-DEC-010`). The value is
 * derived from the booking's order and is immutable for the life of the
 * conversation. A page rendering a picker between "message the professional" and
 * "message the salon" would be offering a choice the server does not accept.
 */
export const CHAT_COUNTERPARTY_TYPES = ['professional', 'business'] as const;
export type ChatCounterpartyType = (typeof CHAT_COUNTERPARTY_TYPES)[number];

export function isChatCounterpartyType(value: unknown): value is ChatCounterpartyType {
  return typeof value === 'string' && (CHAT_COUNTERPARTY_TYPES as readonly string[]).includes(value);
}

/** Which side of a conversation a reader sits on. */
export const CHAT_SIDES = ['customer', 'seller'] as const;
export type ChatSide = (typeof CHAT_SIDES)[number];

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every reason the server declines to start or accept a message, as a closed
 * set.
 *
 * Closed for the reason the payment and AI vocabularies are closed: the
 * alternative is an internal state name or an exception message reaching a
 * browser. A new distinction is a deliberate edit here plus the Persian copy
 * that goes with it.
 *
 * Note what is **absent**: there is no `blocked_by_them`. A blocked sender is
 * told only `blocked`, identically to a sender who did the blocking, because
 * `V32-DEC-014` requires that the blocked party is never told who blocked them —
 * and a distinct reason code would tell them.
 */
export const CHAT_REFUSAL_REASONS = [
  /**
   * No qualifying booking relationship exists.
   *
   * Also what a nonexistent counterparty and a counterparty the caller has never
   * transacted with both produce, deliberately: distinguishing them would
   * confirm that a professional exists.
   */
  'not_eligible',
  /** The 90-day window since the last qualifying booking has closed. */
  'send_window_closed',
  /** A block exists in one direction or the other. Never says which. */
  'blocked',
  /** A moderator permanently closed this conversation for sending. */
  'conversation_closed',
  /** The sender is under a platform-wide chat sending restriction. */
  'sender_restricted',
  /** Empty, or longer than `CHAT_MAX_MESSAGE_CHARACTERS`. */
  'message_too_long',
  /** The per-minute or per-day send throttle fired. */
  'rate_limited',
  /** This reporter already has an open report on this conversation. */
  'report_already_open',
  /** The 5-reports-per-24-hours limit fired. */
  'report_rate_limited',
] as const;

export type ChatRefusalReason = (typeof CHAT_REFUSAL_REASONS)[number];

export function isChatRefusalReason(value: unknown): value is ChatRefusalReason {
  return typeof value === 'string' && (CHAT_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * Whether the composer should stay open.
 *
 * Only `message_too_long` is fixable by editing and resending. Everything else
 * is a limit, a wait, or a decision, and leaving the composer enabled for those
 * invites a user to retype the same message into the same refusal.
 */
export function isRetryableAfterEditing(reason: ChatRefusalReason): boolean {
  return reason === 'message_too_long';
}

// ---------------------------------------------------------------------------
// Reporting and moderation
// ---------------------------------------------------------------------------

/**
 * Why a conversation was reported (`V32-DEC-014`).
 *
 * Six of the seven mirror `media.abuse_reports`. `off_platform_payment` is the
 * addition, and it earns its place: taking payment outside the platform is a
 * chat-specific harm with direct financial consequences for the customer, and
 * folding it into `other` would make the single most actionable category
 * invisible in the moderation queue.
 */
export const CHAT_REPORT_REASONS = [
  'harassment',
  'spam',
  'scam_or_fraud',
  'explicit',
  'personal_data',
  'off_platform_payment',
  'other',
] as const;

export type ChatReportReason = (typeof CHAT_REPORT_REASONS)[number];

export function isChatReportReason(value: unknown): value is ChatReportReason {
  return typeof value === 'string' && (CHAT_REPORT_REASONS as readonly string[]).includes(value);
}

/** Report lifecycle. Both non-open states are terminal. */
export const CHAT_REPORT_STATUSES = ['open', 'upheld', 'rejected'] as const;
export type ChatReportStatus = (typeof CHAT_REPORT_STATUSES)[number];

/**
 * What an upheld report may do.
 *
 * Note what is missing: there is no `delete_message` and no `edit_message`.
 * Deleting would destroy the evidence the decision rests on and hand a moderator
 * a power neither participant has. Moderation restricts access and future
 * sending; it does not rewrite what was said (`V32-DEC-014`).
 */
export const CHAT_MODERATION_ACTIONS = ['warn_sender', 'close_conversation', 'restrict_sender'] as const;
export type ChatModerationAction = (typeof CHAT_MODERATION_ACTIONS)[number];

/** Why a conversation is closed for sending. */
export const CHAT_CLOSED_REASONS = ['moderation', 'blocked'] as const;
export type ChatClosedReason = (typeof CHAT_CLOSED_REASONS)[number];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The maximum length of one message, in Unicode CODE POINTS.
 *
 * Code points, not UTF-16 units and not bytes. `"سلام".length` and
 * `[..."سلام"].length` agree; a string containing an emoji does not, because
 * that is a surrogate pair and `.length` counts each half. A limit expressed in
 * UTF-16 units silently halves for some users and not others.
 *
 * Both sides count with `chatTextLength` below, which is exported precisely so
 * the composer's character counter and the server's refusal cannot disagree
 * about what "2000 characters" means.
 */
export const CHAT_MAX_MESSAGE_CHARACTERS = 2000;

/** The optional moderation report note (`V32-DEC-014`). Also code points. */
export const CHAT_MAX_REPORT_NOTE_CHARACTERS = 500;

/** Conversations or messages returned in one page. */
export const CHAT_DEFAULT_PAGE_SIZE = 30;
export const CHAT_MAX_PAGE_SIZE = 100;

/**
 * Poll intervals, in milliseconds.
 *
 * V2 polled the list every 15s and the open thread every 4s, and its own docblock
 * justified both: PHP-FPM does not hold long-lived connections cheaply and a
 * single-city launch does not need sub-second delivery. Neither fact has changed
 * and no evidence of a need for realtime transport exists, so polling is the
 * transport (`V32-DEC-014` milestone boundary).
 *
 * The thread interval is 5s rather than V2's 4s: imperceptible to a reader, and
 * it cuts request volume by a fifth.
 */
export const CHAT_POLL_LIST_MS = 15_000;
export const CHAT_POLL_THREAD_MS = 5_000;

/**
 * Back off to this once a poll has returned nothing several times running, or as
 * soon as the tab is hidden. Resets on any activity.
 *
 * Polling's cost is entirely in the idle case: an open tab nobody is looking at
 * is the one issuing most of the requests.
 */
export const CHAT_POLL_IDLE_MS = 60_000;
export const CHAT_POLL_IDLE_AFTER_EMPTY = 5;

/** Send throttle (`V32-DEC-014`). Enforced in PostgreSQL, not by the client. */
export const CHAT_MAX_MESSAGES_PER_MINUTE = 20;
export const CHAT_MAX_MESSAGES_PER_DAY = 300;

/** New reports per reporter per rolling 24 hours (`V32-DEC-014`). */
export const CHAT_MAX_REPORTS_PER_DAY = 5;

/** Days after the last qualifying booking's end that sending stays open (`V32-DEC-012`). */
export const CHAT_SEND_WINDOW_DAYS = 90;

/** Months a conversation is retained after its last message (`V32-DEC-013`). */
export const CHAT_RETENTION_MONTHS = 24;

/** The bounded window a moderator may read around a reported message (`V32-DEC-015`). */
export const CHAT_MODERATOR_WINDOW_MESSAGES = 50;

/** Days after a report is decided that its window stays readable (`V32-DEC-015`). */
export const CHAT_MODERATOR_POST_DECISION_DAYS = 30;

/**
 * The length of a message, counted the way both sides count it.
 *
 * Normalised to NFC first. Persian text arrives from browsers in more than one
 * normalisation form — the same visible word can be composed or decomposed — and
 * counting the raw string would make the limit depend on which keyboard somebody
 * typed with.
 */
export function chatTextLength(text: string): number {
  return [...text.normalize('NFC')].length;
}

/** Whether a message body is an acceptable length. The server applies the same test. */
export function isAcceptableChatMessage(text: string): boolean {
  const length = chatTextLength(text.trim());
  return length > 0 && length <= CHAT_MAX_MESSAGE_CHARACTERS;
}

/** Whether a report note is acceptable. An absent note is always acceptable. */
export function isAcceptableReportNote(text: string | null | undefined): boolean {
  if (text === null || text === undefined || text.trim() === '') return true;
  return chatTextLength(text.trim()) <= CHAT_MAX_REPORT_NOTE_CHARACTERS;
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** One message as the browser receives it. */
export interface ChatMessageView {
  readonly id: string;
  /** The sender's user id, or null for a message whose author erased their account. */
  readonly senderUserId: string | null;
  /** Which side sent it, so the page can align the bubble without resolving ids. */
  readonly side: ChatSide;
  /**
   * The text — or `null` for a structural placeholder left by account erasure
   * (`V32-DEC-013`).
   *
   * A null body carries no original body, no excerpt, no searchable text, and
   * nothing reconstructable. The page renders a neutral "this message was
   * removed" placeholder; it is a gap with a sequence number, not a redaction of
   * a known string.
   */
  readonly body: string | null;
  /** True when this row is that placeholder. Distinct from an empty body, which cannot exist. */
  readonly erased: boolean;
  /** Monotonic within the conversation. The pagination cursor and the ordering key. */
  readonly sequence: number;
  readonly createdAt: string;
}

/** One conversation in an inbox. Carries no message bodies. */
export interface ChatConversationSummary {
  readonly id: string;
  readonly counterpartyType: ChatCounterpartyType;
  readonly counterpartyId: string;
  readonly messageCount: number;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly startedAt: string;
  /**
   * Whether the caller may send right now, and why not.
   *
   * Computed per request from the booking relationship, the send window, blocks,
   * and moderation state — never cached on the row (`V32-DEC-012`). A page
   * disables the composer on this; the server refuses regardless of what the
   * page believed.
   */
  readonly canSend: boolean;
  readonly cannotSendReason: ChatRefusalReason | null;
  readonly closedReason: ChatClosedReason | null;
}

/** The unread badge. Server-computed; never decremented locally. */
export interface ChatUnreadCountView {
  readonly total: number;
  readonly conversations: number;
}

/** A report as its own reporter sees it back. */
export interface ChatReportView {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly reason: ChatReportReason;
  readonly status: ChatReportStatus;
  readonly createdAt: string;
}
