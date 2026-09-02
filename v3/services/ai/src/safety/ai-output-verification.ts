import { Injectable, Inject, Logger } from '@nestjs/common';

import { AI_MAX_RECOMMENDATIONS_PER_REPLY } from '@beauclick/ai-contract';
import type { AiRecommendationTarget } from '@beauclick/ai-contract';

import {
  AI_PUBLIC_CATALOGUE,
  AiPublicCataloguePort,
} from '../context/ai-context.ports';
import { AiCompletion, AiCompletionSchema } from '../providers/ai-provider.interface';

/**
 * Output validation and independent re-verification (ADR-030 T3, T4).
 *
 * ## Two steps, and they are not the same step
 *
 * **Validation** proves SHAPE. `AiCompletionSchema` says the response is an
 * object with a bounded reply and at most four `{targetType, targetId}` pairs,
 * with no extra keys.
 *
 * **Verification** proves FACT. The catalogue is asked whether each named id
 * currently exists, is currently public, and is currently visible.
 *
 * Conflating them is the single most likely way an AI feature ships a wrong
 * answer confidently, so they are two methods with two names. A UUID that parses
 * and refers to a suspended professional passes the first and fails the second,
 * and only the second is what a customer would act on.
 *
 * `V3_SECURITY_MODEL.md` §5 puts it as a rule: the calling code, not the
 * adapter, is the trust boundary. **A schema-valid response is not authority.**
 *
 * ## Why the catalogue's own record comes back, rather than a yes/no
 *
 * `reverifyProfessionals` returns records, not booleans, and the caller uses the
 * returned `displayName` rather than anything the provider said. That closes the
 * second half of the hallucination problem: a model that invents a real id and
 * attaches a false name to it gets neither, because the name never travelled
 * from the provider in the first place — `AiCompletionSchema` has no field for
 * one.
 *
 * ## Dropping is silent to the customer and loud to the operator
 *
 * A dropped recommendation produces no error and no gap in the reply — the
 * customer reads a sentence and sees fewer cards, which is the correct
 * experience. The count is logged so a provider that starts inventing ids shows
 * up as a rising drop rate rather than as a support ticket six weeks later.
 */

/** One recommendation that survived both steps. */
export interface VerifiedRecommendation {
  readonly targetType: AiRecommendationTarget;
  readonly targetId: string;
  /** The CATALOGUE's display name, never the provider's. */
  readonly displayName: string;
  readonly position: number;
}

export interface VerifiedAssistantReply {
  readonly reply: string;
  readonly recommendations: readonly VerifiedRecommendation[];
  /** How many the provider named that did not survive. Counted, never shown. */
  readonly droppedCount: number;
}

/** Thrown when a provider's output does not satisfy the schema. Never reaches a browser. */
export class AiOutputRejectedError extends Error {
  constructor(readonly issues: string[]) {
    super(`Provider output rejected: ${issues.join('; ')}`);
  }
}

@Injectable()
export class AiOutputVerifier {
  private readonly logger = new Logger('AiOutputVerifier');

  constructor(@Inject(AI_PUBLIC_CATALOGUE) private readonly catalogue: AiPublicCataloguePort) {}

  /**
   * Step one: shape.
   *
   * `safeParse`, and a throw on failure with the issues attached — the issues go
   * to a log and a counter, never to a response body. A provider's validation
   * error can quote the provider's own output, which is precisely the raw
   * completion ADR-030 T6 forbids from leaving the process.
   *
   * There is no partial parse and no repair attempt. "Accept the fields that
   * happened to be valid" is how a malformed response becomes a half-real one,
   * and a repaired response is a response nobody wrote.
   */
  validate(draft: unknown): AiCompletion {
    const parsed = AiCompletionSchema.safeParse(draft);
    if (!parsed.success) {
      // The PATHS and the rule violated, not the values. `issue.message` is
      // zod's own text ("expected string, received number"), which describes
      // the schema rather than the content.
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`);
      throw new AiOutputRejectedError(issues);
    }
    return parsed.data;
  }

  /**
   * Step two: fact.
   *
   * Order is preserved from the provider's list — the assistant is allowed to
   * express an opinion about which of several real professionals to mention
   * first, because ordering a set of already-public records is not a claim about
   * the world. What it is not allowed to do is decide that a record exists, and
   * that is what this method takes away.
   *
   * Duplicates collapse: a provider naming the same professional three times
   * produces one recommendation, not three cards for one person.
   */
  async verify(completion: AiCompletion): Promise<VerifiedAssistantReply> {
    const claimed = completion.recommendations;
    if (claimed.length === 0) {
      return { reply: completion.reply, recommendations: [], droppedCount: 0 };
    }

    const professionalIds = unique(claimed.filter((r) => r.targetType === 'professional').map((r) => r.targetId));
    const serviceIds = unique(claimed.filter((r) => r.targetType === 'service').map((r) => r.targetId));

    // Both lookups in parallel: they are independent reads and a customer is
    // waiting. Each returns ONLY currently-public, currently-visible records --
    // the port's contract, not this method's filtering.
    const [professionals, services] = await Promise.all([
      professionalIds.length > 0 ? this.catalogue.reverifyProfessionals(professionalIds) : Promise.resolve([]),
      serviceIds.length > 0 ? this.catalogue.reverifyServices(serviceIds) : Promise.resolve([]),
    ]);

    const professionalNames = new Map(professionals.map((p) => [p.professionalId, p.displayName]));
    const serviceNames = new Map(services.map((s) => [s.serviceId, s.name]));

    const survivors: VerifiedRecommendation[] = [];
    const seen = new Set<string>();

    for (const claim of claimed) {
      const key = `${claim.targetType}:${claim.targetId}`;
      if (seen.has(key)) continue;

      const displayName =
        claim.targetType === 'professional' ? professionalNames.get(claim.targetId) : serviceNames.get(claim.targetId);

      // Absent from the re-verification result means hallucinated, hidden,
      // suspended, deleted, foreign, or simply stale between the provider call
      // and this read. All six are the same outcome, deliberately: the reason a
      // record is not currently showable is not information the customer needs,
      // and distinguishing them here would mean asking the catalogue to explain
      // absences, which is a wider read than "is this public".
      if (displayName === undefined) continue;

      seen.add(key);
      survivors.push({
        targetType: claim.targetType,
        targetId: claim.targetId,
        displayName,
        position: survivors.length + 1,
      });

      if (survivors.length >= AI_MAX_RECOMMENDATIONS_PER_REPLY) break;
    }

    const droppedCount = claimed.length - survivors.length;
    if (droppedCount > 0) {
      // Counts and ids only. An id that failed verification is a public
      // catalogue identifier or a fabricated one; neither is subject data, and
      // an operator debugging a misbehaving provider needs to see them.
      this.logger.warn(
        `Dropped ${droppedCount} of ${claimed.length} provider recommendation(s) that failed re-verification.`,
      );
    }

    return { reply: completion.reply, recommendations: survivors, droppedCount };
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
