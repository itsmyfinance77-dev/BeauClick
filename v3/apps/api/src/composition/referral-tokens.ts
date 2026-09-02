/**
 * V3.2-C Story #12 contributes the referral outbox source and the referral
 * event handlers under dedicated tokens, which `DomainCompositionModule`
 * concatenates into the single `OUTBOX_SOURCES` and `DOMAIN_EVENT_HANDLERS` the
 * relay consumes.
 *
 * Separate tokens rather than contributing to the shared ones, for the reason
 * `ai-tokens.ts` and `phase3-tokens.ts` both record: Nest resolves a token to
 * ONE provider, so two modules both providing `OUTBOX_SOURCES` would not merge
 * — the second would silently replace the first, and half the event graph would
 * stop working with no error anywhere.
 *
 * ## Unlike `ai`, this module BOTH produces and consumes
 *
 * `AI_OUTBOX_SOURCES` has no handler counterpart because the AI module reacts
 * to nothing. Referral is the opposite on both counts: it **consumes**
 * `BookingCompleted` to qualify (`V32-DEC-018`) and **produces**
 * `ReferralQualified`, which it then also consumes to notify (`V32-DEC-033`).
 *
 * Both handlers live under one token because they are one story's event
 * surface, and splitting them would suggest they could be composed
 * independently — which they cannot: a deployment that qualified referrals
 * without notifying, or notified without qualifying, is not a configuration
 * anybody should be able to assemble by accident.
 */
export const REFERRAL_OUTBOX_SOURCES = Symbol('BEAUCLICK_REFERRAL_OUTBOX_SOURCES');

export const REFERRAL_EVENT_HANDLERS = Symbol('BEAUCLICK_REFERRAL_EVENT_HANDLERS');
