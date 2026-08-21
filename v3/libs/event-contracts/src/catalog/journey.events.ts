import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * Journey's own facts. Note what is NOT here: the beauty profile's free-text
 * `notes` field, and a goal's title.
 *
 * The notes exclusion is the rule V2 got right and V3 makes structural (see
 * JourneyContextProvider): customer-authored free text must never travel to
 * a consumer that did not need it. A goal's title is customer-authored too,
 * so the event carries the goal's STRUCTURED intent -- specialty, city,
 * budget -- and nothing a person wrote in their own words.
 */

export const BeautyGoalCreated = defineEvent({
  name: 'BeautyGoalCreated',
  version: 1,
  aggregateType: 'beauty_goal',
  producer: 'journey',
  description: 'A customer set a specific, time-boundable beauty goal.',
  idempotency: 'goalId is the natural key; the timeline consumer holds UNIQUE(user_id, source_type, source_id).',
  schema: z.object({
    goalId: uuid(),
    userId: uuid(),
    // No `title` -- see this file's header.
    specialtyId: uuid().nullable(),
    cityId: uuid().nullable(),
    budgetToman: z.number().int().nonnegative().nullable(),
    targetDate: z.string().nullable(),
    createdAt: instant(),
  }),
});

export const BeautyGoalStatusChanged = defineEvent({
  name: 'BeautyGoalStatusChanged',
  version: 1,
  aggregateType: 'beauty_goal',
  producer: 'journey',
  description: 'A goal was achieved, abandoned, or reopened.',
  idempotency: 'Status CAS on the goal row.',
  schema: z.object({
    goalId: uuid(),
    userId: uuid(),
    fromStatus: z.string(),
    toStatus: z.enum(['active', 'achieved', 'abandoned']),
    changedAt: instant(),
  }),
});

export const JOURNEY_EVENTS = [BeautyGoalCreated, BeautyGoalStatusChanged];
