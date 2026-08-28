import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * analytics' subject-data contract.
 *
 * THE ONE DECISION HERE, stated because it is the least obvious in the set:
 * `analytics.events` rows are RETAINED with their `actor_id` and `subject_id`
 * intact, rather than having those columns nulled.
 *
 * The tempting move is to null them -- it looks like more privacy. It is not.
 * Nulling breaks `daily_metrics`' distinct-actor counts, which are computed by
 * a rollup that can be re-run over history: a re-run after an erasure would
 * silently produce different platform numbers for months that are already
 * closed, and nothing would report that it had happened. Meanwhile the privacy
 * gain is nil, because an id whose identity row has been anonymized already
 * points at nobody -- which is the whole anonymization-with-referential-
 * integrity model (`V3.1_PRODUCT_ROADMAP.md` §9).
 *
 * `dimensions` is the column that WOULD be a problem, and it is not one by
 * construction: `AnalyticsIngestionService` derives dimensions from
 * contract-validated event payloads, and every V3 contract's schema strips
 * unknown keys before an event is written (see `emitContractEvent`). There is
 * no path by which a name or a phone number reaches it.
 *
 * The export is deliberately narrow. A subject is entitled to the events they
 * were the actor of; they are not entitled to the platform's aggregate metrics,
 * which are the platform's data and describe thousands of other people.
 */
@Injectable()
export class AnalyticsSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'analytics';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'analytics.events',
      disposition: 'retained',
      reason:
        'The immutable fact store behind every platform metric. Ids and contract-derived dimensions only; anonymous once the identity behind actor_id is destroyed, and nulling the ids would silently change already-closed reporting periods.',
    },
    {
      table: 'analytics.daily_metrics',
      disposition: 'no_subject_data',
      reason: 'Aggregates over a whole day and scope. No row describes an individual.',
    },
    {
      table: 'analytics.rollup_state',
      disposition: 'no_subject_data',
      reason: 'Which day each rollup last computed. Bookkeeping.',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const events = await manager.query(
      `SELECT event_id, event_type, aggregate_type, aggregate_id, dimensions, metric_value, occurred_at
         FROM analytics.events
        WHERE actor_id = $1
        ORDER BY occurred_at DESC
        LIMIT 5000`,
      [userId],
    );

    return [
      {
        key: 'events',
        description: 'رویدادهای تحلیلی مربوط به فعالیت شما',
        rows: events as Array<Record<string, unknown>>,
      },
    ];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: [
        {
          table: 'analytics.events',
          reason: 'the fact store behind closed reporting periods; ids only, anonymous once identity is destroyed',
        },
      ],
    };
  }
}
