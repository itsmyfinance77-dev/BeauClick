/**
 * V3.2-B contributes its outbox source under a dedicated token, which
 * `DomainCompositionModule` concatenates into the single `OUTBOX_SOURCES` the
 * relay consumes.
 *
 * A separate token rather than contributing to an existing one, for the reason
 * `phase3-tokens.ts` records: Nest resolves a token to ONE provider, so two
 * modules both providing `OUTBOX_SOURCES` would not merge -- the second would
 * silently replace the first, and half the event graph would stop working with
 * no error anywhere.
 *
 * There is deliberately no `CHAT_EVENT_HANDLERS` token. `chat` CONSUMES nothing:
 * it produces two events and reacts to none. `MessageSent` reaches notification
 * and analytics through the generic handlers those modules already register.
 */
export const CHAT_OUTBOX_SOURCES = Symbol('BEAUCLICK_CHAT_OUTBOX_SOURCES');
