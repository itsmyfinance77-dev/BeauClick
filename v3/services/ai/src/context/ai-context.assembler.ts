import { Inject, Injectable } from '@nestjs/common';

import {
  AI_JOURNEY_CONTEXT,
  AI_PUBLIC_CATALOGUE,
  AiCustomerContext,
  AiJourneyContextPort,
  AiPublicCataloguePort,
} from './ai-context.ports';

/**
 * Builds the one object a provider ever receives.
 *
 * ## Assembly is field by field, and that is the enforcement
 *
 * Nothing here spreads an object, and nothing here passes a value it did not
 * name. Every field of the returned context is written out explicitly, so
 * widening any upstream type — journey adding a field, the catalogue port
 * gaining one — cannot silently widen what reaches a prompt. It would produce
 * an unused value and a failing key-set assertion, which is the reviewable act
 * `V32-DEC-005` requires.
 *
 * The cheapest way to break this file would be `return { journey, ...extras }`.
 * There is no `extras`, and there is no code path that could produce one.
 *
 * ## Scope comes from the session, never from an argument that could be forged
 *
 * `assemble(userId)` takes an already-authenticated user id, exactly as
 * `JourneyContextProvider.inferAiDefaults` does and for the same reason:
 * authorization has already happened, and keeping this function incapable of
 * authorizing anything is what stops it from becoming the place where the check
 * is accidentally skipped.
 *
 * ## Candidate limits are bounds, not preferences
 *
 * The catalogue is asked for a small number of candidates and a small number of
 * services. That bound is a cost control, a prompt-size control, and — with a
 * real provider — a token-bill control, and it is applied HERE rather than left
 * to whatever the search read model happens to return by default.
 */

/**
 * How many candidate professionals enter the context.
 *
 * Six rather than four (`AI_MAX_RECOMMENDATIONS_PER_REPLY`): the provider should
 * be able to choose among slightly more than it can recommend, or the
 * "recommendation" is just the search order with a sentence around it. Small
 * enough that the prompt stays bounded.
 */
const CANDIDATE_LIMIT = 6;

/** How many service rows enter the context. Roughly two per candidate. */
const SERVICE_LIMIT = 12;

@Injectable()
export class AiContextAssembler {
  constructor(
    @Inject(AI_JOURNEY_CONTEXT) private readonly journey: AiJourneyContextPort,
    @Inject(AI_PUBLIC_CATALOGUE) private readonly catalogue: AiPublicCataloguePort,
  ) {}

  async assemble(userId: string): Promise<AiCustomerContext> {
    const inferred = await this.journey.inferAiDefaults(userId);

    // Named explicitly rather than passed through. `inferAiDefaults` returns a
    // type with three structured fields today; if it ever returns four, this
    // line still sends three, and the fourth is a deliberate edit.
    const journeyContext = {
      specialtyIds: inferred.specialtyIds,
      cityId: inferred.cityId,
      budgetToman: inferred.budgetToman,
    };

    const candidates = await this.catalogue.findCandidates({
      cityId: journeyContext.cityId,
      specialtyIds: journeyContext.specialtyIds,
      maxPriceToman: journeyContext.budgetToman,
      limit: CANDIDATE_LIMIT,
    });

    const services =
      candidates.length === 0
        ? []
        : await this.catalogue.findServicesFor(
            candidates.map((candidate) => candidate.professionalId),
            SERVICE_LIMIT,
          );

    // Three keys. `ai-context.spec.ts` asserts this exact set against a literal
    // it writes out itself -- see that file for why it does not import the
    // constant next to the type.
    return { journey: journeyContext, candidates, services };
  }
}
