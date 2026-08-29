/**
 * The context boundary, expressed as types.
 *
 * This file IS `V32-DEC-005`. The owner ratified exactly four customer context
 * sources on 2026-08-29 — string-free Journey inference, public professional
 * summaries, public service summaries, approved public search summaries — and
 * this is where that list becomes something a compiler enforces rather than
 * something a reviewer remembers.
 *
 * ## Why types, and not prompt wording
 *
 * `V3_SECURITY_MODEL.md` §5 requires excluded material to be "deliberately
 * excluded from the context entirely, not merely access-controlled within it".
 * The difference is total. A prompt that says *do not reveal the customer's
 * notes* is an instruction to a component that cannot reliably distinguish
 * instruction from data. A type with no string field is a fact about the
 * program.
 *
 * `JourneyAiContext` established the pattern in Phase 3 and this generalises
 * it. Three rules follow from it, and all three are asserted by tests:
 *
 * 1. **No generic map crosses this boundary.** No `Record<string, unknown>`, no
 *    spread of an entity, no `toJSON()`. Every context object is assembled
 *    field by field from values whose types cannot hold prose.
 * 2. **The KEY SET is asserted, not the values.** `ai-context.spec.ts` compares
 *    the assembled context's keys against a literal. A new key fails that test
 *    until somebody edits it, which is the reviewable act this whole design
 *    exists to force.
 * 3. **Public free text is excluded even though it is public.** A professional's
 *    biography is a public catalogue field and it is NOT here. A public string
 *    authored by one party, fed into a prompt on behalf of another, is an
 *    injection surface with no compensating benefit: the assistant does not
 *    need a biography to say that a professional exists, is verified, works in
 *    this city, and charges this much.
 *
 * ## Structurally excluded, and there is no port that could return them
 *
 * Journey `notes` and goal titles; review comment text and professional reply
 * text; CRM notes; internal chat messages; moderation reasons; verification
 * evidence; phone numbers, emails, and every other direct identifier; financial
 * figures; professional and tenant-private analytics; and arbitrary database
 * queries. `V32-DEC-005` fixes that list, and the enforcement is that no
 * interface below declares a method returning any of it.
 */

/**
 * The Journey seam, mirroring `JourneyContextProvider.inferAiDefaults`.
 *
 * Redeclared here rather than imported: `ai` may not depend on `journey`
 * (ADR-011, enforced by lint), and the composition root implements this port by
 * calling the real provider. The redeclaration is not duplication of logic —
 * it is the ONE place `ai` states what it is willing to receive, and it is
 * deliberately narrower-or-equal to what journey is willing to give.
 *
 * Three fields, all structured. There is no string field of any kind, and
 * adding one would be a visible edit to this interface.
 */
export interface AiJourneyContext {
  readonly specialtyIds?: readonly string[];
  readonly cityId?: string;
  readonly budgetToman?: number;
}

export interface AiJourneyContextPort {
  /**
   * Takes a user id and returns a context.
   *
   * Note what it does NOT take: a request, a session, or a flag.
   * **Authorization has already happened before this is called.** Keeping this
   * incapable of authorizing anything is what stops it from becoming the place
   * where the check is accidentally skipped — the same reasoning
   * `JourneyContextProvider` records for its own signature.
   */
  inferAiDefaults(userId: string): Promise<AiJourneyContext>;
}

export const AI_JOURNEY_CONTEXT = Symbol('BEAUCLICK_AI_JOURNEY_CONTEXT');

/**
 * A professional, in the public fields the assistant may see.
 *
 * Every field here is already visible to an anonymous visitor on the public
 * catalogue. The list is closed: adding a field is an edit to this interface
 * and to the composition root's mapper, and the mapper is written as an
 * explicit field-by-field construction so a widened upstream type cannot
 * silently widen this one.
 *
 * `bio` is absent on purpose — see this file's header, rule 3.
 * `ownerUserId`, contact details, verification evidence, internal notes, and
 * every ranking internal are absent because they are not public.
 */
export interface AiPublicProfessionalSummary {
  readonly professionalId: string;
  readonly displayName: string;
  readonly cityId: string | null;
  readonly cityName: string | null;
  readonly specialtyNames: readonly string[];
  readonly isVerified: boolean;
  readonly minPriceToman: number | null;
  readonly maxPriceToman: number | null;
  readonly ratingAvg: number;
  readonly reviewCount: number;
}

/**
 * A service offering, in the public fields the assistant may see.
 *
 * `name` is the one string here, and it is a catalogue label rather than prose:
 * bounded at 191 characters by the schema, authored as a product name, and
 * already rendered to every anonymous visitor. It is included because a
 * recommendation that cannot name the service is not a recommendation.
 * A service `description`, where one exists, is NOT included, for the same
 * reason `bio` is not.
 */
export interface AiPublicServiceSummary {
  readonly serviceId: string;
  readonly professionalId: string;
  readonly name: string;
  readonly priceToman: number;
  readonly durationMinutes: number;
}

/** What the assistant is allowed to ask the catalogue for. Structured filters only. */
export interface AiCatalogueQuery {
  readonly cityId?: string;
  readonly specialtyIds?: readonly string[];
  readonly maxPriceToman?: number;
  readonly limit: number;
}

/**
 * The catalogue and search seam.
 *
 * Implemented in the composition root over the EXISTING search read model and
 * provider service. `ai` does not rank, does not index, and does not query the
 * database: ADR-029 §1 forbids a second search or recommendation engine, and
 * `F-05` records why.
 */
export interface AiPublicCataloguePort {
  /**
   * Candidate professionals for a structured query.
   *
   * The ORDER is the existing search read model's order. `ai` does not re-rank
   * and has no relevance formula of its own — there is exactly one ranking
   * implementation in this platform (ADR-021), and this is a reader of it.
   */
  findCandidates(query: AiCatalogueQuery): Promise<readonly AiPublicProfessionalSummary[]>;

  /** The public services offered by the given professionals. Bounded by `limit`. */
  findServicesFor(professionalIds: readonly string[], limit: number): Promise<readonly AiPublicServiceSummary[]>;

  /**
   * Independent re-verification — the trust boundary (ADR-030 T3).
   *
   * Called with the ids a provider named, AFTER its response has been parsed,
   * and returns only those that CURRENTLY exist, are CURRENTLY public, and are
   * CURRENTLY visible. Hallucinated, hidden, suspended, deleted, foreign, and
   * malformed ids come back absent, and the caller drops them.
   *
   * The signature is deliberately "give me ids, receive records" rather than
   * "is this id valid": returning the record forces the caller to use the
   * catalogue's own display name rather than the one the provider claimed,
   * which closes the second half of the hallucination problem. A model that
   * invents a real id and a false name gets neither.
   *
   * `V3_SECURITY_MODEL.md` §5: the calling code, not the adapter, is the trust
   * boundary. A schema-valid response is not authority.
   */
  reverifyProfessionals(ids: readonly string[]): Promise<readonly AiPublicProfessionalSummary[]>;

  reverifyServices(ids: readonly string[]): Promise<readonly AiPublicServiceSummary[]>;
}

export const AI_PUBLIC_CATALOGUE = Symbol('BEAUCLICK_AI_PUBLIC_CATALOGUE');

/**
 * The complete customer context, and the ONLY thing a provider ever receives.
 *
 * The key set of this object is asserted against a literal by
 * `ai-context.spec.ts`. Three keys, matching the four ratified sources —
 * `candidates` and `services` are both drawn through the catalogue/search port,
 * which is one seam serving two of the four.
 *
 * There is no `userId`, and that is not an oversight. A provider has no use for
 * a customer's identifier and every reason not to hold one: it cannot look
 * anything up with it, it cannot be asked to reveal it, and it cannot leak it
 * into a completion that gets stored. The context describes what the customer
 * is LOOKING FOR, never who they are.
 */
export interface AiCustomerContext {
  readonly journey: AiJourneyContext;
  readonly candidates: readonly AiPublicProfessionalSummary[];
  readonly services: readonly AiPublicServiceSummary[];
}

/**
 * The exact key set, exported so the assertion lives next to the definition.
 *
 * A test importing this and comparing it to `Object.keys(context)` would prove
 * nothing — both would be wrong together. The test compares the ASSEMBLED
 * context's keys against a literal it writes out itself; this constant exists
 * so the intended set is stated once, in the file that defines the type, for a
 * reader rather than for the assertion.
 */
export const AI_CONTEXT_KEYS = ['journey', 'candidates', 'services'] as const;
