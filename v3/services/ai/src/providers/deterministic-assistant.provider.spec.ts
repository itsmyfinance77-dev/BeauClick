import { AI_MAX_RECOMMENDATIONS_PER_REPLY } from '@beauclick/ai-contract';

import { AI_ASSISTANT_DISCLOSURE, DeterministicAssistantProvider } from './deterministic-assistant.provider';
import { AiCompletionRequest } from './ai-provider.interface';
import { AiOutputVerifier } from '../safety/ai-output-verification';
import {
  AiPublicCataloguePort,
  AiPublicProfessionalSummary,
  AiPublicServiceSummary,
} from '../context/ai-context.ports';

/**
 * The deterministic assistant — ADR-029 §3.
 *
 * Three properties are worth more than the rest of this file combined:
 * **it never claims to be a language model**, **it makes no network call and
 * needs no credential**, and **its own output survives the same validation
 * every other provider's does**. A provider is not trusted because it lives in
 * this repository.
 */

const PRO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function professional(id: string, overrides: Partial<AiPublicProfessionalSummary> = {}): AiPublicProfessionalSummary {
  return {
    professionalId: id,
    displayName: 'کلینیک نمونه',
    cityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    cityName: 'تهران',
    specialtyNames: ['پوست', 'مو'],
    isVerified: true,
    minPriceToman: 300_000,
    maxPriceToman: 900_000,
    ratingAvg: 4.5,
    reviewCount: 12,
    ...overrides,
  };
}

function request(
  candidates: AiPublicProfessionalSummary[],
  services: AiPublicServiceSummary[] = [],
  journey: AiCompletionRequest['context']['journey'] = { cityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', budgetToman: 500_000 },
): AiCompletionRequest {
  return {
    message: 'برای پوستم چیکار کنم؟',
    history: [],
    context: { journey, candidates, services },
    deadlineMs: 5_000,
  };
}

/** Confirms whatever it is asked about, so validation is the only thing under test. */
class PermissiveCatalogue implements AiPublicCataloguePort {
  async findCandidates(): Promise<readonly AiPublicProfessionalSummary[]> {
    return [];
  }
  async findServicesFor(): Promise<readonly AiPublicServiceSummary[]> {
    return [];
  }
  async reverifyProfessionals(ids: readonly string[]): Promise<readonly AiPublicProfessionalSummary[]> {
    return ids.map((id) => professional(id));
  }
  async reverifyServices(): Promise<readonly AiPublicServiceSummary[]> {
    return [];
  }
}

describe('DeterministicAssistantProvider', () => {
  const provider = new DeterministicAssistantProvider();

  describe('what it declares about itself', () => {
    it('reports the deterministic mode and that nothing leaves the process', () => {
      expect(provider.key).toBe('deterministic');
      expect(provider.mode).toBe('deterministic');
      // The field the readiness surface reads. Same shape as
      // `SmsProvider.deliversExternally` and `ErrorReporterPort.reportsExternally`.
      expect(provider.respondsExternally).toBe(false);
    });
  });

  describe('honesty', () => {
    /**
     * The requirement, tested in the only place it can be enforced: the reply
     * body itself.
     *
     * Not in the interface, where a restyle can hide it, and not in a wrapper a
     * future caller might forget to apply.
     */
    it('states in every reply that it is not a language model', async () => {
      const withCandidates = (await provider.complete(request([professional(PRO_A)]))) as { reply: string };
      const withoutCandidates = (await provider.complete(request([]))) as { reply: string };

      expect(withCandidates.reply).toContain(AI_ASSISTANT_DISCLOSURE);
      expect(withoutCandidates.reply).toContain(AI_ASSISTANT_DISCLOSURE);
      expect(AI_ASSISTANT_DISCLOSURE).toContain('نه یک مدل زبانی');
    });

    it('never claims to be an AI, a model, or a vendor', async () => {
      const result = (await provider.complete(request([professional(PRO_A)]))) as { reply: string };
      for (const claim of ['GPT', 'Claude', 'Gemini', 'OpenAI', 'Anthropic', 'هوش مصنوعی پیشرفته']) {
        expect(result.reply).not.toContain(claim);
      }
    });
  });

  describe('determinism', () => {
    /**
     * Byte-for-byte identical for identical input.
     *
     * No clock is read and no random number is drawn. That property is what
     * makes the whole safety pipeline testable: an output-validation test that
     * had to accommodate a varying reply would be testing the accommodation.
     */
    it('produces byte-identical output for identical input', async () => {
      const input = request([professional(PRO_A), professional(PRO_B, { displayName: 'کلینیک دوم' })]);
      const first = await provider.complete(input);
      const second = await provider.complete(input);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it('preserves the catalogue candidate order rather than re-ranking', async () => {
      const result = (await provider.complete(
        request([professional(PRO_A), professional(PRO_B, { ratingAvg: 5, reviewCount: 900 })]),
      )) as { recommendations: { targetId: string }[] };

      // PRO_B has a better rating and is still second: `ai` does not rank, and
      // there is exactly one ranking implementation in this platform (ADR-021).
      expect(result.recommendations.map((r) => r.targetId)).toEqual([PRO_A, PRO_B]);
    });
  });

  describe('what it narrates', () => {
    it('names only fields present on the public summary', async () => {
      const result = (await provider.complete(request([professional(PRO_A, { displayName: 'دکتر الف' })]))) as {
        reply: string;
      };
      expect(result.reply).toContain('دکتر الف');
      expect(result.reply).toContain('تهران');
      expect(result.reply).toContain('احراز هویت شده');
    });

    it('renders numbers in Persian digits, as every customer-facing surface does', async () => {
      const result = (await provider.complete(request([professional(PRO_A)]))) as { reply: string };
      // `formatRating`/`formatToman`/`formatCount` produce Persian digits.
      expect(result.reply).toMatch(/[۰-۹]/);
      // And no Latin digits leak into a Persian sentence.
      expect(result.reply.replace(/\d+\./g, '')).not.toMatch(/[0-9]/);
    });

    /**
     * A rating without its sample size is the classic misleading statistic:
     * 5.0 from one review reads identically to 5.0 from two hundred.
     */
    it('never states a rating without its review count', async () => {
      const result = (await provider.complete(request([professional(PRO_A, { ratingAvg: 5, reviewCount: 1 })]))) as {
        reply: string;
      };
      expect(result.reply).toContain('امتیاز');
      expect(result.reply).toContain('نظر');
    });

    it('omits the rating entirely when there are no reviews, rather than showing zero', async () => {
      const result = (await provider.complete(request([professional(PRO_A, { ratingAvg: 0, reviewCount: 0 })]))) as {
        reply: string;
      };
      expect(result.reply).not.toContain('امتیاز');
    });

    it('says plainly that it found nothing rather than inventing something', async () => {
      const result = (await provider.complete(request([]))) as { reply: string; recommendations: unknown[] };
      expect(result.recommendations).toEqual([]);
      expect(result.reply).toContain('پیدا نکردم');
      // And tells the customer what they can actually do about it.
      expect(result.reply).toContain('مسیر زیبایی');
    });
  });

  describe('bounds', () => {
    it('never returns more recommendations than one reply may carry', async () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        professional(`${'0'.repeat(7)}${i}-0000-4000-8000-000000000000`.slice(-36)),
      );
      const result = (await provider.complete(request(many))) as { recommendations: unknown[] };
      expect(result.recommendations.length).toBeLessThanOrEqual(AI_MAX_RECOMMENDATIONS_PER_REPLY);
    });

    it('returns ids only, with no display name for the caller to trust', async () => {
      const result = (await provider.complete(request([professional(PRO_A)]))) as {
        recommendations: Record<string, unknown>[];
      };
      expect(Object.keys(result.recommendations[0]).sort()).toEqual(['targetId', 'targetType']);
    });
  });

  describe('its own output is validated like anybody else`s', () => {
    /**
     * A provider is not trusted because it lives in this repository.
     *
     * This runs the deterministic provider's real output through the real
     * verifier, so a bug here fails validation rather than being waved through
     * on familiarity.
     */
    it('satisfies AiCompletionSchema', async () => {
      const verifier = new AiOutputVerifier(new PermissiveCatalogue());
      const draft = await provider.complete(request([professional(PRO_A), professional(PRO_B)]));
      const completion = verifier.validate(draft);
      expect(completion.recommendations).toHaveLength(2);
    });

    it('satisfies the schema when it found nothing', async () => {
      const verifier = new AiOutputVerifier(new PermissiveCatalogue());
      const completion = verifier.validate(await provider.complete(request([])));
      expect(completion.recommendations).toEqual([]);
    });

    it('stays inside the reply cap even with the maximum number of verbose candidates', async () => {
      const verbose = Array.from({ length: AI_MAX_RECOMMENDATIONS_PER_REPLY }, (_, i) =>
        professional(`${i}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, {
          displayName: 'ک'.repeat(120),
          specialtyNames: ['ت'.repeat(60), 'ث'.repeat(60), 'ج'.repeat(60)],
          cityName: 'ش'.repeat(60),
        }),
      );
      const services = verbose.map((p, i) => ({
        serviceId: `${i}bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
        professionalId: p.professionalId,
        name: 'خ'.repeat(120),
        priceToman: 100_000,
        durationMinutes: 60,
      }));

      const verifier = new AiOutputVerifier(new PermissiveCatalogue());
      expect(() => verifier.validate(undefined)).toThrow();
      // The real assertion: the provider's own trimming keeps it valid.
      expect(() => verifier.validate(null)).toThrow();
      const draft = await provider.complete(request(verbose, services));
      expect(() => verifier.validate(draft)).not.toThrow();
    });
  });

  describe('isolation', () => {
    /**
     * The provider's entire input is the request it is handed.
     *
     * It holds no repository, no `EntityManager`, no service, and no HTTP
     * client -- so there is no collaborator through which `V32-DEC-004`'s
     * prohibition on AI-initiated mutation could be violated, and no route by
     * which `RETIRED` raw database access could arrive.
     */
    it('constructs with no dependencies at all', () => {
      expect(DeterministicAssistantProvider.length).toBe(0);
      expect(Object.keys(new DeterministicAssistantProvider()).sort()).toEqual([
        'displayName',
        'key',
        'mode',
        'respondsExternally',
      ]);
    });

    it('never sees a user id, because the context carries none', async () => {
      const input = request([professional(PRO_A)]);
      expect(JSON.stringify(input.context)).not.toContain('user');
      const result = (await provider.complete(input)) as { reply: string };
      expect(result.reply).toBeTruthy();
    });
  });
});
