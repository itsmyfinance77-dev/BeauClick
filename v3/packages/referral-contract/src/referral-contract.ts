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
 * **No reward value, point total, cap, or qualification vocabulary.** No
 * `qualified`, `capped`, `reversed`, `reward`, or `points` constant or state.
 * `V32-DEC-016` sets both referral reward values to **0** and `V32-DEC-019`
 * caps a referrer at 10 qualified referrals per Tehran calendar month — and
 * none of it is implemented by Stories #11 or #27. A number here that nothing
 * enforces would be a promise a client renders before anything can keep it, and
 * declaring the states would be designing Stories #12 and #28 from here.
 *
 * **No referrer, referee, or counterparty identity shape.** Story #27 adds the
 * claim, and a successful claim returns the caller's **own** attribution facts
 * and nothing about the other party — no user id, no phone, no display name,
 * and above all not the referrer's code, which `V32-DEC-019` forbids from a
 * referee's export in terms. There is no field here that could carry one.
 *
 * **No count of any kind.** Not how many people used a code, not how many
 * invites were sent, not how many times the code was shared. There is no field
 * here that could carry one, and `V32-DEC-033` forbids share-tracking outright.
 *
 * **No refusal vocabulary for the claim route.** Unlike `ChatRefusalReason`,
 * and the difference is the whole security property rather than an omission:
 * `V32-DEC-019` collapses every claim refusal into **one** answer, so a
 * vocabulary here would be a set of names for distinctions the server is
 * forbidden to make — and exporting one would invite a client to switch on a
 * value it can never receive (ADR-036 §8).
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
 * **Owner-ratified.** `V32-DEC-034`, closed on 2026-08-31, ratifies this
 * constant and the length below at exactly the values already implemented, so
 * ratification changed no constant, no migration, and no already-issued code
 * (ADR-035 §3). Changing either is now a **new owner decision** — a register
 * entry, this constant, a `VARCHAR` width in one migration, and regenerating
 * every code already issued — rather than an implementation choice.
 */
export const REFERRAL_CODE_ALPHABET = '123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * How many characters a referral code has.
 *
 * 31^10 is about 8.19e14, or **~49.5 bits** of entropy.
 *
 * Ten rather than six or eight, and the reason is a boundary rather than a
 * taste. `V32-DEC-019` throttles the claim route at 10 attempts per caller per
 * hour — `REFERRAL_CLAIM_ATTEMPTS_PER_HOUR` below — which would make eight
 * characters comfortable. Story #11 generated codes **before that control
 * existed**, so the format had to stand on its own, and ten is the first length
 * at which the code is safe against a **wholly unthrottled** attacker: ≈ 2,598
 * years at 10,000 guesses a second, against ≈ 9.35 billion years at the
 * throttled rate (`V32-DEC-034`).
 *
 * Story #27 has since built that throttle, so the margin is now real rather
 * than hypothetical — but the length is justified without it, which is the
 * property that mattered and the reason eight was refused.
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

// ---------------------------------------------------------------------------
// The attribution claim (V3.2-C Story #27, ADR-036)
// ---------------------------------------------------------------------------

/**
 * How old an account may be and still claim an invitation, in days.
 *
 * `V32-DEC-019`'s claim window, and Issue #27's acceptance criterion states it
 * as **≤ 30 days** — so the boundary is **inclusive**: an account created
 * exactly 30 days ago to the millisecond may still claim.
 *
 * Exported so a page can explain the window without hardcoding it, and so the
 * server and the page cannot disagree about what "too old" means. It is
 * measured as an **absolute UTC duration** from `identity.users.created_at`,
 * never as a calendar boundary — see `REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS`
 * for why that distinction is load-bearing in this domain.
 *
 * A client must not treat this as an authorisation check. It is the server's
 * rule, restated here for display; the server reads the authoritative account
 * age through a narrow port inside the claim's own transaction, and a caller
 * cannot supply it (ADR-036 §4).
 */
export const REFERRAL_CLAIM_MAX_ACCOUNT_AGE_DAYS = 30;

/**
 * How long a pending attribution stands before it lapses, in days.
 *
 * `V32-DEC-017`, and it is an **absolute UTC duration** from the attribution
 * instant — deliberately not a Tehran calendar boundary.
 *
 * The distinction is not pedantry, and this package is exactly where it gets
 * confused: `V32-DEC-019`'s **referrer cap** IS per Tehran calendar month, and
 * it lives one story away (#12). Mixing them would make "90 days" mean
 * something subtly different for a claim recorded at 23:00 than for one at
 * 01:00. Durations between two instants get arithmetic; promises about a
 * person's calendar get a calendar.
 *
 * **This is not the invite link's expiry, and the link still has none.**
 * `V32-DEC-033` gives the link no independent expiry and makes its validity
 * follow the code and the referral lifecycle. What expires here is a *pending
 * attribution* — a relationship that was formed and never qualified — which is
 * a different object from the code that formed it.
 */
export const REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS = 90;

/**
 * How many claim attempts one authenticated caller may make per hour.
 *
 * `V32-DEC-019`. Enforced **in PostgreSQL**, transactionally, not by the
 * in-memory HTTP throttler — whose effective limit multiplies by instance count
 * while `THROTTLE-STORE` is unresolved (ADR-036 §6).
 *
 * **Every attempt counts, including one that is refused.** This number is a
 * **guess rate**, not a comfort setting: `V32-DEC-034` prices the code's length
 * against exactly this figure — 10 per hour against 31^10 is an exhaustive
 * search of ≈ 9.35 billion years — and makes it the stated reason the code is
 * ten characters rather than eight. A limit that counted only successful claims
 * would bound nothing.
 *
 * Exported so a page can pace its own retries rather than discovering the limit
 * by hitting it.
 */
export const REFERRAL_CLAIM_ATTEMPTS_PER_HOUR = 10;

/**
 * The error `code` on **every** refused claim, and there is exactly one.
 *
 * `V32-DEC-019` collapses all six refusal cases — unknown code, revoked code,
 * the caller's own code, already attributed, account too old, already booked —
 * into **one indistinguishable response**, so the route is neither a code
 * oracle nor an account oracle.
 *
 * This is a single constant rather than a vocabulary, and that is the point.
 * A `ReferralClaimRefusalReason` union would be a set of names for distinctions
 * the server is forbidden to make; a client that switched on one would be
 * writing branches that can never be reached, and somebody would eventually
 * "fix" that by making the server send them.
 *
 * The response carries no `details`, no reason, and no discriminator. A client
 * that needs to say something to a customer says the one thing that is true:
 * this code cannot be claimed by this account.
 *
 * A spent throttle (`429`) and a malformed request (`400`) are **not** claim
 * refusals and do not carry this code — neither is an answer about eligibility,
 * and neither reveals anything about another party (ADR-036 §6c, §8).
 */
export const REFERRAL_CLAIM_REFUSED_CODE = 'REFERRAL_CLAIM_REFUSED';

/**
 * What a claim request contains: **the code, and nothing else.**
 *
 * One field, and the closedness is the security property rather than
 * minimalism. The referee is resolved from the authenticated session and is
 * never an input; the referrer is read from the claimed code's row. So the code
 * is the **only client-controlled claim credential in the story**.
 *
 * The server binds this shape to a DTO validated with `whitelist` and
 * `forbidNonWhitelisted`, so any other property — `refereeUserId`,
 * `referrerUserId`, `ownerUserId`, `userId`, `phone`, `createdAt`,
 * `hasCompletedBooking`, `rewardAmount`, `expiresAt`, `status` — is **refused
 * with a 400**, not ignored.
 *
 * Refused rather than ignored, and the difference is real: a silently-dropped
 * `refereeUserId` is a field somebody later wires up by accident, and until
 * they do it trains callers to believe the server read it. A 400 says the field
 * does not exist, which is true. Story #11's empty query DTO makes the same
 * choice for the same reason.
 */
export interface ReferralClaimRequest {
  /** Ten characters from `REFERRAL_CODE_ALPHABET`. `isReferralCodeShape` tests the shape. */
  readonly code: string;
}

/**
 * What a **successful** claim returns: the caller's own two facts.
 *
 * **No referrer identity of any kind** — no user id, no phone, no display name,
 * and above all not the referrer's code. `V32-DEC-019` binds the referee's
 * export to *their own referral fact and never the referrer's bearer code*, and
 * a response is a weaker place to leak one than an export only in that fewer
 * people read it. No closed decision requires the referrer to be named here, so
 * they are not.
 *
 * **No reward, no points, no qualification state, and no status.**
 * `V32-DEC-016` sets both reward values to 0 and qualification is Story #12; a
 * field here would be a promise a client renders before anything can keep it.
 *
 * Both fields are ISO-8601 UTC instants — strings rather than `Date`, because
 * this package crosses a JSON boundary and a `Date` here would be a lie about
 * what arrives.
 */
export interface ReferralClaimResult {
  /** When the attribution was recorded. Immutable thereafter (ADR-036 §3). */
  readonly attributedAt: string;
  /**
   * When this pending attribution lapses — `attributedAt` plus
   * `REFERRAL_PENDING_ATTRIBUTION_EXPIRY_DAYS`, as an absolute UTC duration.
   *
   * The caller's own fact about their own attribution, which is why it is
   * returned at all. What happens when it passes is Story #12's to decide;
   * nothing in this milestone reads it.
   */
  readonly expiresAt: string;
}
