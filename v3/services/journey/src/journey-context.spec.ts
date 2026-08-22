import { Repository } from 'typeorm';
import { JourneyAiContext, JourneyContextProvider } from './journey-context.provider';
import { BeautyGoalEntity, BeautyProfileEntity } from './entities/journey.entities';

/**
 * The AI context boundary (ADR-019), tested where it is cheapest to test.
 *
 * The pg-spec proves the boundary holds against the real database. These cover
 * the part that has nothing to do with storage: given a profile and a goal
 * that both contain customer prose, what comes out.
 *
 * The last test is the one that matters most and is the least obvious: it
 * asserts a property of the RETURNED VALUES rather than of the code that built
 * them, so it keeps holding if someone rewrites `inferAiDefaults` entirely.
 */
describe('JourneyContextProvider.inferAiDefaults', () => {
  const NOTE = 'پوستم به لیزر حساسیت داشت، دکتر گفت شش ماه صبر کنم';
  const GOAL_TITLE = 'آماده شدن برای عروسی خواهرم';

  const build = (
    profile: Partial<BeautyProfileEntity> | null,
    goals: Partial<BeautyGoalEntity>[] = [],
  ): JourneyContextProvider =>
    new JourneyContextProvider(
      { findOne: async () => profile } as unknown as Repository<BeautyProfileEntity>,
      { find: async () => goals } as unknown as Repository<BeautyGoalEntity>,
    );

  it('carries the profile\'s structured preferences', async () => {
    const provider = build({
      preferredSpecialtyIds: ['spec-1', 'spec-2'],
      preferredCityId: 'city-1',
      budgetMaxToman: 900_000,
      notes: NOTE,
    });

    await expect(provider.inferAiDefaults('user-1')).resolves.toEqual({
      specialtyIds: ['spec-1', 'spec-2'],
      cityId: 'city-1',
      budgetToman: 900_000,
    });
  });

  it('lets an active goal override the standing profile', async () => {
    // A specific goal is a more current statement of intent than a preference
    // set once and forgotten.
    const provider = build(
      { preferredSpecialtyIds: ['spec-1'], preferredCityId: 'city-1', budgetMaxToman: 900_000 },
      [{ specialtyId: 'spec-9', cityId: 'city-9', budgetToman: 400_000, title: GOAL_TITLE }],
    );

    await expect(provider.inferAiDefaults('user-1')).resolves.toEqual({
      specialtyIds: ['spec-9'],
      cityId: 'city-9',
      budgetToman: 400_000,
    });
  });

  it('sends the budget CEILING, not the floor', async () => {
    // The question an AI answers is "what can you afford". A minimum budget
    // would exclude everything cheap, which is the opposite of what a customer
    // stating a floor preference wants.
    const provider = build({ budgetMinToman: 100_000, budgetMaxToman: 500_000 });

    await expect(provider.inferAiDefaults('user-1')).resolves.toEqual({ budgetToman: 500_000 });
  });

  it('returns an empty context for a customer with nothing recorded', async () => {
    await expect(build(null).inferAiDefaults('user-1')).resolves.toEqual({});
  });

  it('emits NO STRING VALUE anywhere in the context except specialty ids', async () => {
    const provider = build(
      { preferredSpecialtyIds: ['spec-1'], preferredCityId: 'city-1', budgetMaxToman: 900_000, notes: NOTE },
      [{ specialtyId: 'spec-9', cityId: 'city-9', budgetToman: 400_000, title: GOAL_TITLE }],
    );

    const context: JourneyAiContext = await provider.inferAiDefaults('user-1');
    const serialized = JSON.stringify(context);

    // Checked on the serialized value because that is what an AI provider does
    // with it -- V2's AnthropicProvider put the whole context object into its
    // system prompt, which is precisely why "we did not read the field" is not
    // the same guarantee as "the field cannot be in here".
    expect(serialized).not.toContain(NOTE);
    expect(serialized).not.toContain(GOAL_TITLE);

    // And nothing prose-shaped at all: every string present is an identifier.
    const strings = Object.values(context)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === 'string');
    for (const value of strings) {
      expect(value).not.toMatch(/\s/);
    }
  });
});
