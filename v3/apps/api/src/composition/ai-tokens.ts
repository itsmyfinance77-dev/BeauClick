/**
 * V3.2-A contributes its outbox source under a dedicated token, which
 * `DomainCompositionModule` concatenates into the single `OUTBOX_SOURCES` the
 * relay consumes.
 *
 * A separate token rather than contributing to an existing one, for the reason
 * `phase3-tokens.ts` records: Nest resolves a token to ONE provider, so two
 * modules both providing `OUTBOX_SOURCES` would not merge -- the second would
 * silently replace the first, and half the event graph would stop working with
 * no error anywhere.
 *
 * There is deliberately no `AI_EVENT_HANDLERS` token. The AI module CONSUMES
 * nothing: it produces two events and reacts to none. Its events reach
 * analytics through the platform's existing generic ingestion handler, so
 * there is no bespoke AI consumer and no second place where an AI payload is
 * read.
 */
export const AI_OUTBOX_SOURCES = Symbol('BEAUCLICK_AI_OUTBOX_SOURCES');
