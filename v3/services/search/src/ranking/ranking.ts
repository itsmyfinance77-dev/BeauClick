/**
 * V2's ranking math, carried forward unchanged.
 *
 * `V3_MIGRATION_MATRIX.md` classifies the scoring ALGORITHM as DIRECT REUSE:
 * OpenSearch replaces storage and retrieval, not the arithmetic. That
 * classification is honoured literally here -- every weight, threshold, and
 * curve below is the value V2 shipped, and the shrinkage/cold-start formulas
 * are line-for-line equivalent. Two things are different, both deliberate:
 *
 *   1. The signals arrive from events rather than from cross-plugin SQL, so
 *      `RankingEngine::recompute_all()`'s unbatched full-table cron sweep
 *      (GAP-16) has no equivalent -- a provider is rescored when a signal
 *      about that provider arrives, which is O(1) per event rather than
 *      O(providers) per hour.
 *
 *   2. Ratings had no V3 producer until V3.1 Phase D. From Phase 3 to Phase C
 *      `ratingAvg`/`reviewCount` arrived as 0/0, and that was handled CORRECTLY
 *      rather than specially: the Bayesian term collapses to the platform mean
 *      at zero reviews, and cold-start blending pulls a no-evidence provider
 *      toward the neutral baseline. Nothing was faked and nothing was
 *      special-cased -- the formula simply received the evidence that existed,
 *      which is why turning the producer on in Phase D required no change to
 *      any line below.
 */

export const RankingConfig = {
  /** Phantom average reviews pulling a small sample toward the platform mean. */
  RATING_CONFIDENCE_C: 10.0,
  /** Used only in the cold-boot state where no provider anywhere has a review. */
  RATING_FALLBACK_MEAN: 4.0,

  /** Below this many completed+cancelled bookings, completion rate is neutral, not punished. */
  COMPLETION_RATE_MIN_SAMPLE: 3,
  /** Below this many views, the view->booking ratio is noise. */
  CONVERSION_MIN_VIEWS: 10,

  RECENT_ACTIVITY_SATURATION: 20,

  WEIGHT_RATING_CONFIDENCE: 0.32,
  WEIGHT_VERIFIED: 0.1,
  WEIGHT_COMPLETION_RATE: 0.18,
  WEIGHT_RESPONSE_SPEED: 0.12,
  WEIGHT_PROFILE_COMPLETE: 0.12,
  WEIGHT_RECENT_ACTIVITY: 0.1,
  WEIGHT_CONVERSION: 0.06,

  COLD_START_BASELINE: 0.55,
  COLD_START_EVIDENCE_K: 5.0,

  HIGH_RATING_MIN_AVG: 4.5,
  HIGH_RATING_MIN_COUNT: 5,
  RELIABLE_MIN_RATE: 0.9,
  RELIABLE_MIN_SAMPLE: 5,
  COMPLETE_PROFILE_MIN: 0.99,
} as const;

export interface RankingSignals {
  ratingAvg: number;
  reviewCount: number;
  verified: boolean;
  completedBookings: number;
  cancelledBookings: number;
  createdBookings: number;
  profileViews: number;
  /** 0-1. How much of the profile a customer can actually read before deciding. */
  profileCompleteness: number;
  recentActivityCount: number;
  /**
   * No V3 producer measures this yet (it needs a messaging domain). `null`
   * means "no data" and scores NEUTRAL -- never zero, which would make an
   * unmeasured signal a permanent penalty on every provider equally.
   */
  avgResponseSeconds: number | null;
}

export interface RankingScore {
  value: number;
  signalKeys: string[];
}

export function emptySignals(): RankingSignals {
  return {
    ratingAvg: 0,
    reviewCount: 0,
    verified: false,
    completedBookings: 0,
    cancelledBookings: 0,
    createdBookings: 0,
    profileViews: 0,
    profileCompleteness: 0,
    recentActivityCount: 0,
    avgResponseSeconds: null,
  };
}

/**
 * Profile completeness, 0-1, over the four components a customer actually
 * uses to decide: a name, a description, a location, and at least one
 * bookable service. Deliberately not "how many database columns are non-null"
 * -- that would reward filling in fields nobody reads.
 */
export function profileCompleteness(input: {
  displayName: string;
  bio: string | null;
  cityId: string | null;
  serviceCount: number;
}): number {
  const components = [
    input.displayName.trim().length > 0,
    (input.bio ?? '').trim().length >= 40,
    Boolean(input.cityId),
    input.serviceCount > 0,
  ];
  return components.filter(Boolean).length / components.length;
}

/** Pure function: signals in, score out. No I/O, so every branch is directly testable. */
export function scoreProvider(s: RankingSignals, platformMeanRating: number | null = null): RankingScore {
  const mean = platformMeanRating ?? RankingConfig.RATING_FALLBACK_MEAN;
  const c = RankingConfig.RATING_CONFIDENCE_C;

  // Bayesian shrinkage ("IMDB formula"), chosen over a Wilson interval
  // because this is a 1-5 average with a count, not a binary up/down signal.
  // Concretely: 5.0 from one review shrinks below 4.8 from 250 reviews, so a
  // single perfect review can never outrank a large base of strong ones --
  // without any hard minimum-review-count cutoff.
  const bayesianRating = (c * mean + s.ratingAvg * s.reviewCount) / (c + s.reviewCount);
  const ratingConfidence = clamp01(bayesianRating / 5);

  const verified = s.verified ? 1 : 0;

  const completionSample = s.completedBookings + s.cancelledBookings;
  const completionRate =
    completionSample >= RankingConfig.COMPLETION_RATE_MIN_SAMPLE
      ? s.completedBookings / completionSample
      : 0.5;

  const responseSpeed = normalizeResponseTime(s.avgResponseSeconds);
  const profileComplete = clamp01(s.profileCompleteness);

  // Log scale, capped: rewards "some real activity" far more than the last
  // few events toward the cap, so one hyperactive provider cannot dominate.
  const recentActivity = Math.min(
    1,
    Math.log(1 + s.recentActivityCount) / Math.log(1 + RankingConfig.RECENT_ACTIVITY_SATURATION),
  );

  const conversion =
    s.profileViews >= RankingConfig.CONVERSION_MIN_VIEWS ? clamp01(s.createdBookings / s.profileViews) : 0.5;

  const rawScore =
    RankingConfig.WEIGHT_RATING_CONFIDENCE * ratingConfidence +
    RankingConfig.WEIGHT_VERIFIED * verified +
    RankingConfig.WEIGHT_COMPLETION_RATE * completionRate +
    RankingConfig.WEIGHT_RESPONSE_SPEED * responseSpeed +
    RankingConfig.WEIGHT_PROFILE_COMPLETE * profileComplete +
    RankingConfig.WEIGHT_RECENT_ACTIVITY * recentActivity +
    RankingConfig.WEIGHT_CONVERSION * conversion;

  // Cold-start blend: a provider with little real evidence is pulled toward a
  // neutral baseline rather than judged on signals that are mostly defaults.
  // This only ever protects the genuinely new -- once evidence >= K the
  // provider is scored entirely on their own signals, so it never caps an
  // established one.
  const evidence = s.reviewCount + s.completedBookings;
  const dataConfidence = Math.min(1, evidence / RankingConfig.COLD_START_EVIDENCE_K);
  const blended = dataConfidence * rawScore + (1 - dataConfidence) * RankingConfig.COLD_START_BASELINE;

  return {
    value: round(blended * 100, 4),
    signalKeys: signalKeys(s, completionRate),
  };
}

function normalizeResponseTime(seconds: number | null): number {
  if (seconds === null) return 0.5;
  const ceil = 10 * 60;
  const floor = 24 * 60 * 60;
  if (seconds <= ceil) return 1;
  if (seconds >= floor) return 0;
  return 1 - (seconds - ceil) / (floor - ceil);
}

/** Explainability: a key is recorded only when the raw signal genuinely crosses its bar. */
function signalKeys(s: RankingSignals, completionRate: number): string[] {
  const keys: string[] = [];
  if (s.verified) keys.push('verified');
  if (s.ratingAvg >= RankingConfig.HIGH_RATING_MIN_AVG && s.reviewCount >= RankingConfig.HIGH_RATING_MIN_COUNT) {
    keys.push('high_rating');
  }
  if (s.recentActivityCount > 0) keys.push('recent_activity');
  if (s.profileCompleteness >= RankingConfig.COMPLETE_PROFILE_MIN) keys.push('complete_profile');
  const sample = s.completedBookings + s.cancelledBookings;
  if (sample >= RankingConfig.RELIABLE_MIN_SAMPLE && completionRate >= RankingConfig.RELIABLE_MIN_RATE) {
    keys.push('reliable');
  }
  return keys;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
