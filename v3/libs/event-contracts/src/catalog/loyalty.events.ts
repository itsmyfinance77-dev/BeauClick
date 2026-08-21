import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

export const LoyaltyPointsEarned = defineEvent({
  name: 'LoyaltyPointsEarned',
  version: 1,
  aggregateType: 'loyalty_account',
  producer: 'loyalty',
  description: 'Points were credited for a real, already-happened domain fact.',
  idempotency: 'UNIQUE(reference_type, reference_id, reason) on the ledger -- V2`s strongest idempotency guarantee, preserved verbatim.',
  schema: z.object({
    userId: uuid(),
    entryId: uuid(),
    points: z.number().int(),
    reason: z.string(),
    referenceType: z.string().nullable(),
    referenceId: uuid().nullable(),
    lifetimeEarned: z.number().int().nonnegative(),
    earnedAt: instant(),
  }),
});

export const LoyaltyTierChanged = defineEvent({
  name: 'LoyaltyTierChanged',
  version: 1,
  aggregateType: 'loyalty_account',
  producer: 'loyalty',
  description: 'A customer`s computed tier differs from the last one observed. Tier itself is never stored -- this event records the crossing, not the state.',
  idempotency: 'UNIQUE(user_id, to_tier_slug, crossed_at_lifetime_points) on the tier-crossing log; recomputing the same crossing inserts nothing.',
  schema: z.object({
    userId: uuid(),
    fromTierSlug: z.string().nullable(),
    toTierSlug: z.string().nullable(),
    lifetimeEarned: z.number().int().nonnegative(),
    changedAt: instant(),
  }),
});

export const MembershipActivated = defineEvent({
  name: 'MembershipActivated',
  version: 1,
  aggregateType: 'membership',
  producer: 'loyalty',
  description: 'A membership became active, by tier qualification or an explicit grant.',
  idempotency: 'UNIQUE(user_id) on the membership row -- one membership per user, upserted.',
  schema: z.object({
    userId: uuid(),
    membershipId: uuid(),
    planId: uuid(),
    planSlug: z.string(),
    source: z.enum(['manual', 'tier_qualification']),
    activatedAt: instant(),
    expiresAt: instant().nullable(),
  }),
});

export const MembershipEnded = defineEvent({
  name: 'MembershipEnded',
  version: 1,
  aggregateType: 'membership',
  producer: 'loyalty',
  description: 'A membership expired or was cancelled. One event for both, distinguished by `reason`.',
  idempotency: 'Status CAS from active -- a second sweep finds no active row and emits nothing.',
  schema: z.object({
    userId: uuid(),
    membershipId: uuid(),
    planId: uuid(),
    reason: z.enum(['expired', 'cancelled']),
    endedAt: instant(),
  }),
});

export const LOYALTY_EVENTS = [LoyaltyPointsEarned, LoyaltyTierChanged, MembershipActivated, MembershipEnded];
