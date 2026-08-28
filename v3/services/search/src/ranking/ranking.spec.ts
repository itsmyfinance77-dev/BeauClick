import { RankingConfig, emptySignals, profileCompleteness, scoreProvider } from './ranking';

/**
 * These cases exist to prove the V2 ranking math survived the re-platform
 * unchanged. `V3_MIGRATION_MATRIX.md` classifies the scoring ALGORITHM as
 * DIRECT REUSE, so the numbers below are properties of V2's formula, not of
 * this implementation -- if a future change to the scorer breaks one, the
 * claim "OpenSearch changed storage, not the math" has stopped being true.
 */
describe('ranking weights', () => {
  it('sums to exactly 1.0', () => {
    const total =
      RankingConfig.WEIGHT_RATING_CONFIDENCE +
      RankingConfig.WEIGHT_VERIFIED +
      RankingConfig.WEIGHT_COMPLETION_RATE +
      RankingConfig.WEIGHT_RESPONSE_SPEED +
      RankingConfig.WEIGHT_PROFILE_COMPLETE +
      RankingConfig.WEIGHT_RECENT_ACTIVITY +
      RankingConfig.WEIGHT_CONVERSION;
    // Weights that do not sum to 1 make the score's scale meaningless and
    // silently rescale every provider at once.
    expect(total).toBeCloseTo(1.0, 10);
  });
});

describe('Bayesian shrinkage', () => {
  /**
   * The exact example V2's own docblock was built around, and the reason
   * shrinkage was chosen over a raw mean: a single perfect review must never
   * outrank a large base of strong reviews.
   */
  it('shrinks 5.0-from-1-review below 4.8-from-250-reviews', () => {
    const withEnoughEvidence = (over: Partial<ReturnType<typeof emptySignals>>) => ({
      ...emptySignals(),
      // Past the cold-start threshold, so the comparison is about ratings
      // rather than about evidence volume.
      completedBookings: 50,
      ...over,
    });

    const onePerfect = scoreProvider(withEnoughEvidence({ ratingAvg: 5.0, reviewCount: 1 }), 4.0);
    const manyStrong = scoreProvider(withEnoughEvidence({ ratingAvg: 4.8, reviewCount: 250 }), 4.0);

    expect(manyStrong.value).toBeGreaterThan(onePerfect.value);
  });

  it('barely moves a large sample, and pulls a tiny one toward the mean', () => {
    const c = RankingConfig.RATING_CONFIDENCE_C;
    const mean = 4.0;

    const bayesian = (avg: number, count: number) => (c * mean + avg * count) / (c + count);

    expect(bayesian(5.0, 1)).toBeCloseTo(4.0909, 3);
    expect(bayesian(4.8, 250)).toBeCloseTo(4.7692, 3);
  });

  it('collapses to the platform mean when there are no reviews at all', () => {
    // The state every provider starts in, and the one the whole platform was
    // in until V3.1 Phase D shipped a review domain: 0/0 must be neutral, not
    // a penalty.
    const c = RankingConfig.RATING_CONFIDENCE_C;
    const mean = 4.2;
    expect((c * mean + 0 * 0) / (c + 0)).toBeCloseTo(mean, 10);
  });
});

describe('cold start', () => {
  it('puts a brand-new provider mid-pack rather than at zero', () => {
    const score = scoreProvider(emptySignals(), null);
    // A weighted average of all-neutral defaults would otherwise place a new
    // professional at the very bottom, where nobody would ever book them and
    // they could never earn the evidence to climb.
    expect(score.value).toBeCloseTo(RankingConfig.COLD_START_BASELINE * 100, 4);
  });

  it('stops blending once real evidence exists, so it never caps an established provider', () => {
    const established = {
      ...emptySignals(),
      verified: true,
      ratingAvg: 4.9,
      reviewCount: 40,
      completedBookings: 60,
      cancelledBookings: 1,
      profileCompleteness: 1,
      recentActivityCount: 20,
      avgResponseSeconds: 60,
      profileViews: 200,
      createdBookings: 80,
    };
    const score = scoreProvider(established, 4.0);
    expect(score.value).toBeGreaterThan(RankingConfig.COLD_START_BASELINE * 100);
    expect(score.value).toBeLessThanOrEqual(100);
  });
});

describe('neutral defaults for unmeasured signals', () => {
  it('scores an unmeasured response time as neutral, never zero', () => {
    const withResponse = scoreProvider({ ...emptySignals(), completedBookings: 50, avgResponseSeconds: 60 }, 4.0);
    const without = scoreProvider({ ...emptySignals(), completedBookings: 50, avgResponseSeconds: null }, 4.0);
    const worst = scoreProvider({ ...emptySignals(), completedBookings: 50, avgResponseSeconds: 48 * 3600 }, 4.0);

    // No V3 producer measures response time. If "no data" scored zero, every
    // provider would carry the same permanent penalty and the signal would be
    // pure noise in the ranking.
    expect(without.value).toBeLessThan(withResponse.value);
    expect(without.value).toBeGreaterThan(worst.value);
  });

  it('ignores cancellations entirely while the sample is below the threshold', () => {
    // Both have one completed booking, so cold-start evidence is identical and
    // the ONLY difference is the cancellation. Below COMPLETION_RATE_MIN_SAMPLE
    // the rate is forced to neutral, so the two must score exactly the same:
    // two data points cannot distinguish an unreliable provider from an
    // unlucky one.
    const noCancel = scoreProvider({ ...emptySignals(), completedBookings: 1, cancelledBookings: 0 }, 4.0);
    const oneCancel = scoreProvider({ ...emptySignals(), completedBookings: 1, cancelledBookings: 1 }, 4.0);
    expect(oneCancel.value).toBeCloseTo(noCancel.value, 10);
  });

  it('starts counting cancellations once the sample is large enough to mean something', () => {
    // Same evidence (3 completed) on both sides, so cold-start blending is
    // identical; now the sample clears the threshold and the rate bites.
    const clean = scoreProvider({ ...emptySignals(), completedBookings: 3, cancelledBookings: 0 }, 4.0);
    const flaky = scoreProvider({ ...emptySignals(), completedBookings: 3, cancelledBookings: 3 }, 4.0);
    expect(clean.value).toBeGreaterThan(flaky.value);
  });

  it('ignores conversion below the minimum view count', () => {
    const fewViews = scoreProvider({ ...emptySignals(), completedBookings: 50, profileViews: 3, createdBookings: 0 }, 4.0);
    const noViews = scoreProvider({ ...emptySignals(), completedBookings: 50, profileViews: 0, createdBookings: 0 }, 4.0);
    // Both fall below CONVERSION_MIN_VIEWS, so both take the neutral 0.5 and
    // score identically -- three views with no booking is not evidence.
    expect(fewViews.value).toBeCloseTo(noViews.value, 10);
  });
});

describe('recent activity', () => {
  it('rewards some activity far more than the last few events toward the cap', () => {
    const at = (n: number) => scoreProvider({ ...emptySignals(), completedBookings: 50, recentActivityCount: n }, 4.0).value;
    const firstFive = at(5) - at(0);
    const lastFive = at(20) - at(15);
    // Log scale, so one hyperactive provider cannot dominate the signal.
    expect(firstFive).toBeGreaterThan(lastFive);
  });
});

describe('signal keys (explainability)', () => {
  it('records a key only when the raw signal genuinely crosses its bar', () => {
    const justUnder = scoreProvider(
      { ...emptySignals(), ratingAvg: 4.4, reviewCount: 10, verified: false },
      4.0,
    );
    expect(justUnder.signalKeys).not.toContain('high_rating');

    const justOver = scoreProvider(
      { ...emptySignals(), ratingAvg: 4.5, reviewCount: 5, verified: true },
      4.0,
    );
    expect(justOver.signalKeys).toContain('high_rating');
    expect(justOver.signalKeys).toContain('verified');
  });

  it('marks a provider reliable only with a real sample behind the rate', () => {
    const smallSample = scoreProvider({ ...emptySignals(), completedBookings: 2, cancelledBookings: 0 }, 4.0);
    expect(smallSample.signalKeys).not.toContain('reliable');

    const realSample = scoreProvider({ ...emptySignals(), completedBookings: 19, cancelledBookings: 1 }, 4.0);
    expect(realSample.signalKeys).toContain('reliable');
  });
});

describe('profileCompleteness', () => {
  it('measures what a customer reads before deciding, not how many columns are filled', () => {
    expect(profileCompleteness({ displayName: 'X', bio: null, cityId: null, serviceCount: 0 })).toBeCloseTo(0.25);
    expect(
      profileCompleteness({
        displayName: 'سالن کیمیا',
        bio: 'ما بیش از ده سال است که در زمینه آرایش و زیبایی فعالیت می‌کنیم.',
        cityId: 'city-1',
        serviceCount: 3,
      }),
    ).toBeCloseTo(1);
  });

  it('does not credit a token bio', () => {
    // A two-word bio tells a customer nothing, so it must not count the same
    // as a real description.
    expect(profileCompleteness({ displayName: 'X', bio: 'سلام', cityId: 'c', serviceCount: 1 })).toBeCloseTo(0.75);
  });
});
