import { AI_MAX_RECOMMENDATIONS_PER_REPLY, AI_MAX_REPLY_CHARACTERS } from '@beauclick/ai-contract';

import { AiOutputRejectedError, AiOutputVerifier } from './ai-output-verification';
import {
  AiPublicCataloguePort,
  AiPublicProfessionalSummary,
  AiPublicServiceSummary,
} from '../context/ai-context.ports';

/**
 * Output validation and re-verification — ADR-030 T3 and T4.
 *
 * The organising idea, and the reason these are two methods rather than one:
 * **validation proves SHAPE, verification proves FACT.** A UUID that parses and
 * refers to a suspended professional passes the first and fails the second, and
 * only the second is what a customer would act on.
 */

const REAL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REAL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HALLUCINATED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUSPENDED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SERVICE_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/**
 * A catalogue that knows about two verified professionals and one service.
 *
 * `SUSPENDED` and `HALLUCINATED` are deliberately absent from what re-verify
 * returns, because the port's contract is "only what is CURRENTLY public and
 * CURRENTLY visible" -- a suspended record and an invented one are the same
 * outcome from this side of the boundary.
 */
class StubCatalogue implements AiPublicCataloguePort {
  professionalCalls: string[][] = [];
  serviceCalls: string[][] = [];

  async findCandidates(): Promise<readonly AiPublicProfessionalSummary[]> {
    return [];
  }
  async findServicesFor(): Promise<readonly AiPublicServiceSummary[]> {
    return [];
  }

  async reverifyProfessionals(ids: readonly string[]): Promise<readonly AiPublicProfessionalSummary[]> {
    this.professionalCalls.push([...ids]);
    const known: Record<string, string> = { [REAL_A]: 'کلینیک الف', [REAL_B]: 'کلینیک ب' };
    return ids
      .filter((id) => id in known)
      .map((id) => ({
        professionalId: id,
        displayName: known[id],
        cityId: null,
        cityName: null,
        specialtyNames: [],
        isVerified: true,
        minPriceToman: null,
        maxPriceToman: null,
        ratingAvg: 0,
        reviewCount: 0,
      }));
  }

  async reverifyServices(ids: readonly string[]): Promise<readonly AiPublicServiceSummary[]> {
    this.serviceCalls.push([...ids]);
    return ids
      .filter((id) => id === SERVICE_A)
      .map((id) => ({
        serviceId: id,
        professionalId: REAL_A,
        name: 'خدمت الف',
        priceToman: 100_000,
        durationMinutes: 60,
      }));
  }
}

function verifier(catalogue: AiPublicCataloguePort = new StubCatalogue()): AiOutputVerifier {
  return new AiOutputVerifier(catalogue);
}

describe('AiOutputVerifier.validate — shape', () => {
  it('accepts a well-formed completion', () => {
    const result = verifier().validate({
      reply: 'سلام',
      recommendations: [{ targetType: 'professional', targetId: REAL_A }],
    });
    expect(result.reply).toBe('سلام');
    expect(result.recommendations).toHaveLength(1);
  });

  it.each([
    ['a non-object', 'just a string'],
    ['null', null],
    ['a missing reply', { recommendations: [] }],
    ['an empty reply', { reply: '', recommendations: [] }],
    ['a missing recommendations array', { reply: 'سلام' }],
    ['a non-uuid target id', { reply: 'سلام', recommendations: [{ targetType: 'professional', targetId: 'not-a-uuid' }] }],
    ['an unknown target type', { reply: 'سلام', recommendations: [{ targetType: 'slot', targetId: REAL_A }] }],
  ])('rejects %s', (_label, draft) => {
    expect(() => verifier().validate(draft)).toThrow(AiOutputRejectedError);
  });

  /**
   * `strict()` is load-bearing, not tidiness.
   *
   * A provider that starts returning `{reply, recommendations, actions}` must
   * fail loudly rather than have its `actions` silently dropped by a permissive
   * parse -- because the day somebody adds handling for `actions` is the day
   * `V32-DEC-004`'s prohibition on AI-initiated mutation stops being structural.
   */
  it('rejects an unrecognised top-level key rather than ignoring it', () => {
    expect(() =>
      verifier().validate({ reply: 'سلام', recommendations: [], actions: [{ type: 'create_booking' }] }),
    ).toThrow(AiOutputRejectedError);
  });

  it('rejects an unrecognised key inside a recommendation', () => {
    expect(() =>
      verifier().validate({
        reply: 'سلام',
        // A provider supplying its own display name is exactly what must not be
        // trusted -- the catalogue's name is used instead. There is no field
        // for one, and supplying it is a rejection.
        recommendations: [{ targetType: 'professional', targetId: REAL_A, displayName: 'a name it invented' }],
      }),
    ).toThrow(AiOutputRejectedError);
  });

  /**
   * The caps are on ACCEPTANCE, not truncation.
   *
   * Taking a prefix of an over-long list would normalise a misbehaving
   * provider's output into looking correct, which is the failure mode this whole
   * layer exists to prevent.
   */
  it('rejects an over-count recommendation list rather than truncating it', () => {
    const tooMany = Array.from({ length: AI_MAX_RECOMMENDATIONS_PER_REPLY + 1 }, () => ({
      targetType: 'professional' as const,
      targetId: REAL_A,
    }));
    expect(() => verifier().validate({ reply: 'سلام', recommendations: tooMany })).toThrow(AiOutputRejectedError);
  });

  it('rejects an over-long reply rather than trimming it', () => {
    const tooLong = 'ا'.repeat(AI_MAX_REPLY_CHARACTERS + 1);
    expect(() => verifier().validate({ reply: tooLong, recommendations: [] })).toThrow(AiOutputRejectedError);
  });

  it('measures the reply in code points, so an emoji-rich reply is not falsely rejected', () => {
    const atLimit = '👋'.repeat(AI_MAX_REPLY_CHARACTERS);
    expect(() => verifier().validate({ reply: atLimit, recommendations: [] })).not.toThrow();
  });

  /**
   * The error carries paths and codes, never the provider's own text.
   *
   * A validation message that quoted the output would put a raw completion into
   * a log line, which is exactly what ADR-030 T6 forbids.
   */
  it('reports the failing path and rule without echoing the provider output', () => {
    const secret = 'THE_PROVIDER_SAID_SOMETHING_SENSITIVE';
    try {
      verifier().validate({ reply: secret, recommendations: 'not an array' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AiOutputRejectedError);
      const rejected = error as AiOutputRejectedError;
      expect(rejected.issues.join(' ')).toContain('recommendations');
      expect(rejected.message).not.toContain(secret);
      expect(rejected.issues.join(' ')).not.toContain(secret);
    }
  });
});

describe('AiOutputVerifier.verify — fact', () => {
  it('keeps a recommendation whose target is currently public and visible', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [{ targetType: 'professional', targetId: REAL_A }],
    });
    expect(result.recommendations).toHaveLength(1);
    expect(result.droppedCount).toBe(0);
  });

  it('drops a hallucinated id', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [{ targetType: 'professional', targetId: HALLUCINATED }],
    });
    expect(result.recommendations).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a hidden, suspended, or deleted target the same way it drops an invented one', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [{ targetType: 'professional', targetId: SUSPENDED }],
    });
    expect(result.recommendations).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  /**
   * The whole point, in one case: a response that is entirely schema-valid and
   * entirely wrong produces a stored reply with ZERO recommendations rather than
   * a failure.
   *
   * The customer reads a sentence and sees no cards, which is the correct
   * experience -- an error page would tell them the platform is broken when what
   * actually happened is that the platform refused to vouch for something.
   */
  it('produces a reply with no recommendations rather than failing, when every id is invalid', async () => {
    const result = await verifier().verify({
      reply: 'این چند گزینه را ببینید',
      recommendations: [
        { targetType: 'professional', targetId: HALLUCINATED },
        { targetType: 'professional', targetId: SUSPENDED },
      ],
    });
    expect(result.reply).toBe('این چند گزینه را ببینید');
    expect(result.recommendations).toEqual([]);
    expect(result.droppedCount).toBe(2);
  });

  it('keeps the survivors and drops the rest from a mixed list', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [
        { targetType: 'professional', targetId: REAL_A },
        { targetType: 'professional', targetId: HALLUCINATED },
        { targetType: 'professional', targetId: REAL_B },
      ],
    });
    expect(result.recommendations.map((r) => r.targetId)).toEqual([REAL_A, REAL_B]);
    expect(result.droppedCount).toBe(1);
  });

  /**
   * The second half of the hallucination problem.
   *
   * A model that invents a real id and attaches a false name to it gets neither,
   * because the name never travelled from the provider -- `AiCompletionSchema`
   * has no field for one -- and the catalogue's own name is used.
   */
  it('uses the catalogue display name, which is the only one available', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [{ targetType: 'professional', targetId: REAL_A }],
    });
    expect(result.recommendations[0].displayName).toBe('کلینیک الف');
  });

  it('collapses duplicates so one professional produces one card, not three', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [
        { targetType: 'professional', targetId: REAL_A },
        { targetType: 'professional', targetId: REAL_A },
        { targetType: 'professional', targetId: REAL_A },
      ],
    });
    expect(result.recommendations).toHaveLength(1);
  });

  it('assigns contiguous positions from one, after dropping', async () => {
    const result = await verifier().verify({
      reply: 'سلام',
      recommendations: [
        { targetType: 'professional', targetId: HALLUCINATED },
        { targetType: 'professional', targetId: REAL_A },
        { targetType: 'professional', targetId: REAL_B },
      ],
    });
    // Not 2 and 3. A gap would render as a missing card the page has to explain.
    expect(result.recommendations.map((r) => r.position)).toEqual([1, 2]);
  });

  it('verifies professionals and services independently, asking only for what was named', async () => {
    const catalogue = new StubCatalogue();
    const result = await verifier(catalogue).verify({
      reply: 'سلام',
      recommendations: [
        { targetType: 'professional', targetId: REAL_A },
        { targetType: 'service', targetId: SERVICE_A },
      ],
    });

    expect(catalogue.professionalCalls).toEqual([[REAL_A]]);
    expect(catalogue.serviceCalls).toEqual([[SERVICE_A]]);
    expect(result.recommendations.map((r) => r.targetType)).toEqual(['professional', 'service']);
  });

  it('does not call the catalogue at all when the provider named nothing', async () => {
    const catalogue = new StubCatalogue();
    await verifier(catalogue).verify({ reply: 'سلام', recommendations: [] });
    expect(catalogue.professionalCalls).toEqual([]);
    expect(catalogue.serviceCalls).toEqual([]);
  });

  it('never asks the catalogue about a type the provider did not name', async () => {
    const catalogue = new StubCatalogue();
    await verifier(catalogue).verify({
      reply: 'سلام',
      recommendations: [{ targetType: 'professional', targetId: REAL_A }],
    });
    expect(catalogue.serviceCalls).toEqual([]);
  });
});
