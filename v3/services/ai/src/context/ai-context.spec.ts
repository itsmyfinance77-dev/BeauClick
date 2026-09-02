import { AiContextAssembler } from './ai-context.assembler';
import {
  AiCatalogueQuery,
  AiJourneyContext,
  AiJourneyContextPort,
  AiPublicCataloguePort,
  AiPublicProfessionalSummary,
  AiPublicServiceSummary,
} from './ai-context.ports';

/**
 * The context boundary — `V32-DEC-005`, made a test rather than a promise.
 *
 * The key assertion in this file is the KEY SET one, and it is written out as a
 * literal rather than imported from `AI_CONTEXT_KEYS`. Importing the constant
 * would compare the code to itself: a new key added to both the type and the
 * constant would pass, which is exactly the change this test exists to catch.
 * The literal is a second, independent statement of the ratified list, and
 * disagreement between the two is the signal.
 */

/**
 * A journey port whose backing data contains free text.
 *
 * The point of this stub is what it CANNOT do. `AiJourneyContextPort` returns
 * `AiJourneyContext`, which has no string field, so a hostile implementation
 * cannot smuggle `notes` through — it would not compile. The `notes` and
 * `goalTitle` below are held here to prove that a source having them is not the
 * same as them travelling.
 */
class StubJourneyPort implements AiJourneyContextPort {
  /** What the real journey tables hold. Deliberately never returned. */
  readonly notesTheCustomerWrote = 'پوست حساس دارم و به بنزوئیل پروکساید آلرژی دارم';
  readonly goalTitleTheCustomerWrote = 'قبل از عروسی خواهرم پوستم را درست کنم';

  async inferAiDefaults(_userId: string): Promise<AiJourneyContext> {
    return {
      specialtyIds: ['11111111-1111-4111-8111-111111111111'],
      cityId: '22222222-2222-4222-8222-222222222222',
      budgetToman: 500_000,
    };
  }
}

class StubCataloguePort implements AiPublicCataloguePort {
  lastQuery: AiCatalogueQuery | null = null;

  constructor(
    private readonly candidates: AiPublicProfessionalSummary[] = [],
    private readonly services: AiPublicServiceSummary[] = [],
  ) {}

  async findCandidates(query: AiCatalogueQuery): Promise<readonly AiPublicProfessionalSummary[]> {
    this.lastQuery = query;
    return this.candidates;
  }
  async findServicesFor(): Promise<readonly AiPublicServiceSummary[]> {
    return this.services;
  }
  async reverifyProfessionals(): Promise<readonly AiPublicProfessionalSummary[]> {
    return [];
  }
  async reverifyServices(): Promise<readonly AiPublicServiceSummary[]> {
    return [];
  }
}

function professional(overrides: Partial<AiPublicProfessionalSummary> = {}): AiPublicProfessionalSummary {
  return {
    professionalId: '33333333-3333-4333-8333-333333333333',
    displayName: 'کلینیک نمونه',
    cityId: '22222222-2222-4222-8222-222222222222',
    cityName: 'تهران',
    specialtyNames: ['پوست'],
    isVerified: true,
    minPriceToman: 300_000,
    maxPriceToman: 900_000,
    ratingAvg: 4.5,
    reviewCount: 12,
    ...overrides,
  };
}

describe('AiContextAssembler', () => {
  describe('the exact key set', () => {
    /**
     * The assertion `V32-DEC-005` reduces to.
     *
     * A fourth key means a fourth context source, which is an owner decision.
     * This test failing is the reviewable act the whole design exists to force.
     */
    it('produces exactly three top-level keys, and they are the ratified ones', () => {
      const assembler = new AiContextAssembler(new StubJourneyPort(), new StubCataloguePort());
      return assembler.assemble('user-1').then((context) => {
        expect(Object.keys(context).sort()).toEqual(['candidates', 'journey', 'services']);
      });
    });

    it('produces exactly three journey keys, none of which can hold a string a customer wrote', () => {
      const assembler = new AiContextAssembler(new StubJourneyPort(), new StubCataloguePort());
      return assembler.assemble('user-1').then((context) => {
        expect(Object.keys(context.journey).sort()).toEqual(['budgetToman', 'cityId', 'specialtyIds']);
      });
    });
  });

  describe('journey free text cannot enter the context', () => {
    /**
     * ADR-019's decision, tested by its first consumer.
     *
     * The customer's notes and goal title exist -- the stub holds them -- and
     * they do not appear anywhere in the assembled context, at any depth. This
     * is not because the assembler filters them; there is no code path that
     * could have included them, because `AiJourneyContext` has no field to put
     * them in.
     */
    it('never contains the customer notes or goal title, at any depth', async () => {
      const journey = new StubJourneyPort();
      const assembler = new AiContextAssembler(journey, new StubCataloguePort([professional()]));
      const context = await assembler.assemble('user-1');

      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain(journey.notesTheCustomerWrote);
      expect(serialized).not.toContain(journey.goalTitleTheCustomerWrote);
      // Not merely the exact strings -- no fragment of them.
      expect(serialized).not.toContain('آلرژی');
      expect(serialized).not.toContain('عروسی');
    });

    it('carries only identifiers and numbers out of journey', async () => {
      const assembler = new AiContextAssembler(new StubJourneyPort(), new StubCataloguePort());
      const context = await assembler.assemble('user-1');

      for (const value of Object.values(context.journey)) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          // A uuid or a number. There is no third possibility, and a future
          // field that was neither would fail here.
          expect(typeof item === 'number' || /^[0-9a-f-]{36}$/i.test(String(item))).toBe(true);
        }
      }
    });
  });

  describe('excluded sources have no port to arrive through', () => {
    /**
     * The structural exclusions in `V32-DEC-005`, asserted as an absence.
     *
     * Reviews, CRM notes, internal chat, verification evidence, financial
     * figures, tenant-private analytics, and direct identifiers are excluded --
     * and the enforcement is that `AiPublicCataloguePort` and
     * `AiJourneyContextPort` declare no method returning any of them. This test
     * inspects the port surface itself, so a new method named
     * `getReviewComments` fails here before anybody wires it up.
     */
    it('exposes exactly four catalogue methods, none of which names an excluded source', () => {
      const catalogue = new StubCataloguePort();
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(catalogue)).filter((m) => m !== 'constructor');

      expect(methods.sort()).toEqual([
        'findCandidates',
        'findServicesFor',
        'reverifyProfessionals',
        'reverifyServices',
      ]);

      const forbidden = ['review', 'comment', 'crm', 'note', 'chat', 'message', 'verification', 'evidence', 'phone', 'email', 'revenue', 'settlement', 'earnings', 'finance', 'analytics'];
      for (const method of methods) {
        for (const word of forbidden) {
          expect(method.toLowerCase()).not.toContain(word);
        }
      }
    });

    it('exposes exactly one journey method', () => {
      const journey = new StubJourneyPort();
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(journey)).filter((m) => m !== 'constructor');
      expect(methods).toEqual(['inferAiDefaults']);
    });
  });

  describe('the public professional summary', () => {
    /**
     * `bio` is public and is still excluded (ADR-029 §5).
     *
     * A public string authored by one party, fed into a prompt on behalf of
     * another, is an injection surface with no compensating benefit: the
     * assistant does not need a biography to say a professional exists, is
     * verified, works in this city, and charges this much.
     */
    it('has no field able to hold a professional-authored biography or any other prose', async () => {
      const assembler = new AiContextAssembler(new StubJourneyPort(), new StubCataloguePort([professional()]));
      const context = await assembler.assemble('user-1');

      expect(Object.keys(context.candidates[0]).sort()).toEqual([
        'cityId',
        'cityName',
        'displayName',
        'isVerified',
        'maxPriceToman',
        'minPriceToman',
        'professionalId',
        'ratingAvg',
        'reviewCount',
        'specialtyNames',
      ]);
      expect(context.candidates[0]).not.toHaveProperty('bio');
      expect(context.candidates[0]).not.toHaveProperty('ownerUserId');
      expect(context.candidates[0]).not.toHaveProperty('phone');
    });
  });

  describe('scoping and bounds', () => {
    it('queries the catalogue with the customer own inferred intent and nothing else', async () => {
      const catalogue = new StubCataloguePort();
      const assembler = new AiContextAssembler(new StubJourneyPort(), catalogue);
      await assembler.assemble('user-1');

      expect(Object.keys(catalogue.lastQuery ?? {}).sort()).toEqual([
        'cityId',
        'limit',
        'maxPriceToman',
        'specialtyIds',
      ]);
      // A bound is applied here rather than left to whatever the search read
      // model returns by default -- a cost control, a prompt-size control, and
      // with a real provider a token-bill control.
      expect(catalogue.lastQuery?.limit).toBeGreaterThan(0);
      expect(catalogue.lastQuery?.limit).toBeLessThanOrEqual(10);
    });

    it('does not ask for services when there are no candidates', async () => {
      const catalogue = new StubCataloguePort([]);
      const spy = jest.spyOn(catalogue, 'findServicesFor');
      const assembler = new AiContextAssembler(new StubJourneyPort(), catalogue);

      const context = await assembler.assemble('user-1');
      expect(context.services).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('the context never identifies the customer', () => {
    /**
     * There is no `userId` key, and that is deliberate rather than an oversight.
     *
     * A provider has no use for a customer's identifier and every reason not to
     * hold one: it cannot look anything up with it, it cannot be asked to reveal
     * it, and it cannot leak it into a completion that then gets stored. The
     * context describes what the customer is LOOKING FOR, never who they are.
     */
    it('contains no user id anywhere', async () => {
      const assembler = new AiContextAssembler(new StubJourneyPort(), new StubCataloguePort([professional()]));
      const context = await assembler.assemble('the-customers-real-user-id');

      expect(JSON.stringify(context)).not.toContain('the-customers-real-user-id');
      expect(context).not.toHaveProperty('userId');
    });
  });
});
