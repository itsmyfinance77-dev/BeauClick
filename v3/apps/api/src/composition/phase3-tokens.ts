/**
 * Phase 3 contributes its own handler and outbox lists under dedicated
 * tokens, which `DomainCompositionModule` concatenates into the single
 * `DOMAIN_EVENT_HANDLERS` / `OUTBOX_SOURCES` the relay consumes.
 *
 * Separate tokens rather than contributing to the same one: Nest resolves a
 * token to ONE provider, so two modules both providing `DOMAIN_EVENT_HANDLERS`
 * would not merge -- the second would silently replace the first, and half
 * the event graph would stop working with no error anywhere.
 */
export const PHASE3_EVENT_HANDLERS = Symbol('BEAUCLICK_PHASE3_EVENT_HANDLERS');
export const PHASE3_OUTBOX_SOURCES = Symbol('BEAUCLICK_PHASE3_OUTBOX_SOURCES');
