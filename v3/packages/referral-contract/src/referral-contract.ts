/**
 * The referral contract, in the half both sides can hold.
 *
 * The fifth package of this shape, after `@beauclick/payment-contract`,
 * `@beauclick/ai-contract`, `@beauclick/chat-contract`, and
 * `@beauclick/wishlist-contract`, and for the reason each of those records: the
 * page needs a handful of vocabularies and limits from the domain, and importing
 * the domain to get them would drag `@nestjs/common`, `typeorm`, and every
 * entity into a browser bundle. The alternative — the page keeping its own
 * string literals — works until the two disagree, and the failure is silent.
 *
 * Zero dependencies. No framework, no TypeORM, no decorators, no `zod`.
 *
 * ## What is deliberately NOT here
 *
 * **No reward value, point total, or cap.** `V32-DEC-016` sets both referral
 * reward values to **0** and `V32-DEC-019` caps a referrer at 10 qualified
 * referrals per Tehran calendar month — and none of that is implemented by this
 * story. A number here that nothing enforces would be a promise a client renders
 * before anything can keep it.
 *
 * **No attribution vocabulary.** No `claimed`, `attributed`, `qualified`,
 * `capped`, or `reversed` state. Attribution is Story #27 and it is a separate
 * story because the platform has no signup event and no `isNewUser` signal.
 * Declaring the states now would be designing that story from here.
 *
 * **No referee, referrer, or counterparty shape.** This story knows about
 * exactly one person: the caller, and their own code.
 *
 * **No count of any kind.** Not how many people used a code, not how many
 * invites were sent, not how many times the code was shared. There is no field
 * here that could carry one, and `V32-DEC-033` forbids share-tracking outright.
 */

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

/**
 * The alphabet a referral code is drawn from — 31 characters, uppercase only.
 *
 * Crockford Base32 (which already excludes `I`, `L`, `O`, and `U`) with `0`
 * additionally removed. The exclusions are the point rather than a detail: a
 * referral code is spoken aloud, written on paper, and typed from a screenshot,
 * so every glyph a reader can supply from memory instead of from the screen is a
 * support ticket.
 *
 *  * `I` and `L` are out because of `1`.
 *  * `O` is out because of `0` — and `0` is then out too, because with `O` gone
 *    it is the remaining glyph a reader most often guesses wrong.
 *  * `U` is out because Crockford drops it to avoid accidental obscenity, which
 *    matters more for a string a customer sends to a friend than for one in a
 *    log.
 *  * `1` is **kept**: with both `I` and `L` absent there is nothing left for it
 *    to be confused with.
 *
 * **Not owner-ratified.** ADR-035 §3 records this, the length below, and the
 * resulting entropy as an engineering realisation of `V32-DEC-033`'s closed
 * properties — the owner closed the invite-link format and the share channel,
 * and never specified the code's own shape. Changing it is this constant, a
 * `VARCHAR` width in one migration, and regenerating existing codes.
 */
export const REFERRAL_CODE_ALPHABET = '123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * How many characters a referral code has.
 *
 * 31^10 is about 8.19e14, or **~49.5 bits** of entropy.
 *
 * Ten rather than six or eight, and the reason is a dependency rather than a
 * taste: `V32-DEC-019` throttles the claim route at 10 attempts per caller per
 * hour, which would make eight characters comfortable — but that throttle
 * belongs to the reward story and does not exist yet. Ten is the first length at
 * which the code is safe against an **unthrottled** attacker, so this foundation
 * does not depend on a control a later story owns.
 */
export const REFERRAL_CODE_LENGTH = 10;

/**
 * Whether a string is shaped like a referral code.
 *
 * Shape only. It says nothing about whether the code exists, is the caller's, or
 * may be claimed — those are questions only the server can answer, and Story #27
 * owns the route that answers them. Exported so a page can disable its own paste
 * control on obvious garbage rather than making a request to learn it.
 *
 * Deliberately CASE-SENSITIVE. The alphabet is uppercase, so a lowercase code is
 * not a referral code — and quietly upper-casing here would mean the client and
 * the server disagreed about what the caller typed.
 */
export function isReferralCodeShape(value: unknown): boolean {
  if (typeof value !== 'string' || value.length !== REFERRAL_CODE_LENGTH) return false;
  for (const character of value) {
    if (!REFERRAL_CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The invite link
// ---------------------------------------------------------------------------

/**
 * The path an invite link uses, under the configured public web origin.
 *
 * `V32-DEC-033` fixes the format at `{origin}/invite/{code}`. It carries the
 * code and **nothing else** — no user id, no phone, no display name, and no
 * signature.
 *
 * **The link has no independent expiry.** Its validity follows the code and the
 * referral lifecycle. A separate link expiry would add a third clock, a signing
 * key, and a "this link expired but your code still works" state nobody can
 * explain — which is exactly why the decision refuses one.
 */
export const REFERRAL_INVITE_PATH_SEGMENT = 'invite';

/**
 * Builds the invite URL from an origin and a code.
 *
 * Lives HERE, in the zero-dependency contract, because both sides build it: the
 * server returns it on the read route, and the page rebuilds it when it renders
 * a fallback or a share sheet. Two independent implementations of one URL format
 * is the kind of duplication that silently stops agreeing, and the failure mode
 * is an invite link that 404s for the person it was sent to.
 *
 * A trailing slash on the origin is tolerated rather than rejected: it is the
 * single most common way a deployment gets `PUBLIC_WEB_BASE_URL` slightly wrong,
 * and a doubled slash in a customer-visible link is a worse outcome than a
 * lenient join.
 */
export function buildReferralInviteUrl(origin: string, code: string): string {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${base}/${REFERRAL_INVITE_PATH_SEGMENT}/${code}`;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

/**
 * How a referrer may pass an invite on, as a closed set.
 *
 * `V32-DEC-033`, and the membership is the decision:
 *
 *  * `copy_code` and `copy_link` are **unconditional fallbacks** and are always
 *    present. A surface that offers neither has no share capability at all.
 *  * `native_share` is approved as **contract and design only**. This milestone
 *    ships no production frontend, so nothing calls `navigator.share`; what
 *    ships is the payload shape below and the capability name.
 *
 * Note what is absent, and that the absence is a vendor boundary rather than an
 * oversight: there is no `sms`, `email`, `push`, `whatsapp`, `telegram`, or
 * `instagram` member. Platform-sent SMS and email are gated by dependency-ledger
 * rows 6 and 7, push is V3.3-B/V3.4-A, and every social-network share API is
 * refused outright along with any share-tracking pixel. A member here would be a
 * capability a client would build a button for.
 */
export const REFERRAL_SHARE_CHANNELS = ['copy_code', 'copy_link', 'native_share'] as const;
export type ReferralShareChannel = (typeof REFERRAL_SHARE_CHANNELS)[number];

/**
 * The channels that must work everywhere, with no capability check.
 *
 * Separated from the full list so a page cannot accidentally treat native share
 * as a fallback. `navigator.share` is absent on most desktop browsers and is
 * refused outside a user gesture even where it exists; a surface that degraded
 * to it would have no share capability at all on the platforms most likely to be
 * used for copying a link into a chat window.
 */
export const REFERRAL_FALLBACK_SHARE_CHANNELS: readonly ReferralShareChannel[] = ['copy_code', 'copy_link'];

/**
 * The share sheet's heading.
 *
 * **Engineering-authored placeholder copy, and marked as such deliberately.**
 * `V32-DEC-033` requires a fixed template rather than free text, and the
 * dependency ledger records approved referral legal and disclosure copy as a
 * **public-release** gate (blocker 16) that does not block this backend
 * milestone. So this ships neutral: it names no person, promises no reward, and
 * makes no claim about who sent anything.
 */
export const REFERRAL_SHARE_TITLE = 'دعوت به بیوکلیک';

/**
 * The fixed share template, with the code as its only variable.
 *
 * Written in the **referrer's** voice, because the referrer is who sends it.
 * `V32-DEC-033` forbids any milestone artefact from stating or implying that the
 * platform sent an invitation, so the text is what a person would write, not
 * what a system would announce.
 *
 * It names no reward and no amount. `V32-DEC-016` sets both referral values to
 * **0** as an honest disabled state, and copy promising a benefit that pays
 * nothing would be the dishonest version of that decision.
 *
 * Lives here rather than in the service for the reason `buildReferralInviteUrl`
 * does: the page rebuilds this string when it renders a clipboard fallback, and
 * two templates that must stay identical is one template plus a bug.
 */
export function buildReferralShareText(code: string): string {
  return `با کد دعوت ${code} در بیوکلیک ثبت‌نام کنید.`;
}

/**
 * What a referrer hands to a share sheet, or copies by hand.
 *
 * Shaped to match the `ShareData` a browser's `navigator.share` accepts — title,
 * text, url — so a page can pass it straight through without assembling
 * anything. Assembling it on the client is what this package exists to prevent:
 * two templates that must stay identical is one template plus a bug.
 *
 * **Nothing here is stored, and nothing here is personal.** `V32-DEC-033`
 * requires the text to be a fixed template plus the code — not free text — so
 * there is no field a display name, a phone number, or a customer's own prose
 * could enter through.
 *
 * **Nothing here claims the platform sent anything.** The referrer sends the
 * invite. `V32-DEC-033` forbids any milestone artefact from stating or implying
 * otherwise, and a cancelled or aborted native share is a **user choice, not an
 * error** — the copy controls stay untouched and no failure message is shown.
 */
export interface ReferralSharePayload {
  /** Short, for a share sheet's heading. Fixed copy plus nothing. */
  readonly title: string;
  /** The fixed template with the code interpolated. Never free text. */
  readonly text: string;
  /** `{origin}/invite/{code}`. */
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * The caller's own referral identity, as the API returns it.
 *
 * Four fields, and that is the whole shape.
 *
 * There is no `id`. The row's primary key is an internal identifier the caller
 * never needs: the route takes no parameters and addresses nothing, because
 * there is exactly one code per owner and the owner is the session.
 *
 * There is no `createdAt`. It would be the one field on this response that moves
 * information about *when* somebody joined the programme into a payload that
 * gets copied into chat windows — and no client needs it to render a code, a
 * link, or a share sheet.
 *
 * There is no expiry, no usage count, no reward total, and no list of people who
 * used the code. Each is a different story, and two of them are refused outright.
 */
export interface ReferralCodeView {
  /** The code itself, uppercase, `REFERRAL_CODE_LENGTH` characters. */
  readonly code: string;
  /** `{origin}/invite/{code}`, ready to copy. */
  readonly inviteUrl: string;
  /** Fixed-template copy for a share sheet or a clipboard. */
  readonly shareText: string;
  /**
   * Which channels this contract supports, so a page renders controls from the
   * server's vocabulary rather than its own.
   *
   * Always contains both fallbacks. `native_share` is present as a capability
   * the page may offer **where the browser supports it**, and its presence here
   * is not a claim that it will work.
   */
  readonly shareChannels: readonly ReferralShareChannel[];
}
