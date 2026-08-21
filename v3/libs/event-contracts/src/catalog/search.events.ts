import { z } from 'zod';
import { defineEvent } from '../event-contract';
import { instant, uuid } from './common';

/**
 * V2 logged a `search_performed` fact that deliberately never recorded the
 * raw query text. That redaction discipline is preserved and made
 * structural: there is no field on this contract that could hold a query
 * string, so a future author cannot add one by accident -- only by editing
 * the contract and bumping the version, which is a reviewable act.
 *
 * What replaces it is `queryClass` (what KIND of query it was) plus
 * `queryTermCount`. Together those answer every question the analytics
 * surface actually asks -- are people searching, is search returning
 * nothing, are filters doing the work instead of text -- without ever
 * storing what a person typed.
 */

export const SearchPerformed = defineEvent({
  name: 'SearchPerformed',
  version: 1,
  aggregateType: 'search',
  producer: 'search',
  description: 'A search executed. Privacy-safe by construction: the query text has nowhere to go.',
  idempotency: 'Not required -- an append-only analytics fact. Duplicates inflate a count; they corrupt nothing.',
  schema: z.object({
    searchId: uuid(),
    // Never the query itself.
    queryClass: z.enum(['empty', 'text', 'filtered', 'text_and_filtered']),
    queryTermCount: z.number().int().nonnegative(),
    filterKeys: z.array(z.string()),
    sort: z.string(),
    resultCount: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    tookMs: z.number().int().nonnegative(),
    degraded: z.boolean(),
    userId: uuid().nullable(),
    occurredAt: instant(),
  }),
});

export const ProviderProfileViewed = defineEvent({
  name: 'ProviderProfileViewed',
  version: 1,
  aggregateType: 'professional',
  producer: 'search',
  description:
    'A provider profile was opened. The view half of the view-to-booking conversion ranking signal.',
  idempotency:
    'Not required -- an append-only fact. `entityType` is ALWAYS the normalized "provider", which is the closure of GAP-15: V2 logged the raw CPT post type here while every other event logged "provider", making the two uncomparable.',
  schema: z.object({
    entityType: z.literal('provider'),
    professionalId: uuid(),
    // "did this view come from a search result, or a direct link" -- the
    // distinction that makes conversion meaningful rather than a raw ratio.
    source: z.enum(['search', 'direct', 'journey', 'unknown']),
    userId: uuid().nullable(),
    occurredAt: instant(),
  }),
});

export const SEARCH_EVENTS = [SearchPerformed, ProviderProfileViewed];
