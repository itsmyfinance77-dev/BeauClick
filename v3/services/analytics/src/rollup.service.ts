import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AnalyticsEventEntity, DailyMetricEntity, MetricKind, RollupStateEntity } from './entities/analytics.entities';
import { addDays, platformToday } from './platform-day';

interface RollupDefinition {
  metricKey: string;
  eventType: string;
  kind: MetricKind;
  /**
   * When set, the rollup is also computed per provider, so a professional's
   * dashboard reads one pre-aggregated row instead of scanning facts.
   */
  scopeBy?: 'provider_subject' | 'seller_dimension';
}

/**
 * What gets pre-aggregated.
 *
 * Deliberately a short list. §40 warns against full-table analytics scans;
 * §25 warns equally against over-engineering. The resolution is to
 * pre-aggregate only the metrics a dashboard renders on every load, and leave
 * ad-hoc questions to the fact table, which is indexed for exactly that.
 */
const ROLLUPS: RollupDefinition[] = [
  { metricKey: 'bookings_created', eventType: 'BookingCreated', kind: 'event_derived', scopeBy: 'provider_subject' },
  { metricKey: 'bookings_completed', eventType: 'BookingCompleted', kind: 'event_derived', scopeBy: 'provider_subject' },
  { metricKey: 'bookings_cancelled', eventType: 'BookingCancelled', kind: 'event_derived', scopeBy: 'provider_subject' },
  { metricKey: 'profile_views', eventType: 'ProviderProfileViewed', kind: 'event_derived', scopeBy: 'provider_subject' },
  { metricKey: 'orders_paid', eventType: 'OrderPaid', kind: 'event_derived', scopeBy: 'seller_dimension' },
  { metricKey: 'searches', eventType: 'SearchPerformed', kind: 'event_derived' },
  { metricKey: 'notifications_sent', eventType: 'NotificationSent', kind: 'event_derived' },
  { metricKey: 'loyalty_points_earned', eventType: 'LoyaltyPointsEarned', kind: 'event_derived' },
];

const PLATFORM_SCOPE_TYPE = '';
const PLATFORM_SCOPE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Recomputes daily rollups.
 *
 * Two properties worth stating:
 *
 * **Recompute REPLACES, never appends.** Every write is an upsert on
 * (metricKey, day, scope). A sweep that ran twice for the same day would
 * otherwise double every figure -- and unlike a duplicated fact row, there
 * would be nothing to detect it afterwards.
 *
 * **The window is bounded and overlapping.** Each run recomputes the last
 * `LOOKBACK_DAYS` days rather than only today. Facts arrive late: the outbox
 * relay can be behind, and a redelivery after a crash can land a
 * yesterday-dated event this morning. Recomputing only the current day would
 * freeze yesterday's number at whatever it happened to be at midnight.
 */
@Injectable()
export class RollupService {
  private readonly logger = new Logger('AnalyticsRollup');
  private static readonly LOOKBACK_DAYS = 3;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AnalyticsEventEntity) private readonly facts: Repository<AnalyticsEventEntity>,
    @InjectRepository(DailyMetricEntity) private readonly metrics: Repository<DailyMetricEntity>,
    @InjectRepository(RollupStateEntity) private readonly state: Repository<RollupStateEntity>,
  ) {}

  /** Recomputes the recent window for every defined rollup. */
  async runRecent(): Promise<{ metrics: number; rows: number }> {
    const today = platformToday();
    const from = addDays(today, -RollupService.LOOKBACK_DAYS);
    return this.runRange(from, today);
  }

  async runRange(from: string, to: string): Promise<{ metrics: number; rows: number }> {
    let rows = 0;
    for (const rollup of ROLLUPS) {
      rows += await this.computeRollup(rollup, from, to);
      await this.state
        .createQueryBuilder()
        .insert()
        .values({ metricKey: rollup.metricKey, lastComputedDay: to, lastRunAt: new Date(), lastRunRows: rows })
        .orUpdate(['last_computed_day', 'last_run_at', 'last_run_rows'], ['metric_key'])
        .execute();
    }
    this.logger.log(`Rolled up ${ROLLUPS.length} metrics over ${from}..${to} (${rows} rows)`);
    return { metrics: ROLLUPS.length, rows };
  }

  private async computeRollup(rollup: RollupDefinition, from: string, to: string): Promise<number> {
    let written = 0;

    // Platform-wide row.
    const platform = await this.facts
      .createQueryBuilder('e')
      // `TO_CHAR`, not a bare column: node-postgres hydrates a `date` into a
      // JS Date at LOCAL midnight, and `String(thatDate).slice(0, 10)` yields
      // "Thu Aug 20" -- which PostgreSQL then rejects on the way back in.
      // Found by a real-database test; the rollup wrote nothing at all.
      .select("TO_CHAR(e.occurred_on, 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(e.metric_value), 0)', 'sum')
      .addSelect('COUNT(DISTINCT e.actor_id)', 'actors')
      .where('e.event_type = :eventType', { eventType: rollup.eventType })
      .andWhere('e.occurred_on BETWEEN :from AND :to', { from, to })
      .groupBy('e.occurred_on')
      .getRawMany<{ day: string; count: string; sum: string; actors: string }>();

    for (const row of platform) {
      await this.upsert(rollup, row.day, PLATFORM_SCOPE_TYPE, PLATFORM_SCOPE_ID, row);
      written += 1;
    }

    if (!rollup.scopeBy) return written;

    // Per-provider rows. The scope column differs by event shape: a booking
    // event's SUBJECT is the provider, while an order's provider is a
    // dimension of it.
    const scopeExpression =
      rollup.scopeBy === 'provider_subject' ? 'e.subject_id::text' : "e.dimensions ->> 'sellerPartyId'";

    const scoped = await this.facts
      .createQueryBuilder('e')
      .select("TO_CHAR(e.occurred_on, 'YYYY-MM-DD')", 'day')
      .addSelect(scopeExpression, 'scope')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(e.metric_value), 0)', 'sum')
      .addSelect('COUNT(DISTINCT e.actor_id)', 'actors')
      .where('e.event_type = :eventType', { eventType: rollup.eventType })
      .andWhere('e.occurred_on BETWEEN :from AND :to', { from, to })
      .andWhere(`${scopeExpression} IS NOT NULL`)
      .groupBy('e.occurred_on')
      .addGroupBy(scopeExpression)
      .getRawMany<{ day: string; scope: string; count: string; sum: string; actors: string }>();

    for (const row of scoped) {
      await this.upsert(rollup, row.day, 'provider', row.scope, row);
      written += 1;
    }

    return written;
  }

  private async upsert(
    rollup: RollupDefinition,
    day: string,
    scopeType: string,
    scopeId: string,
    row: { count: string; sum: string; actors: string },
  ): Promise<void> {
    await this.metrics
      .createQueryBuilder()
      .insert()
      .values({
        metricKey: rollup.metricKey,
        metricDay: day,
        scopeType,
        scopeId,
        metricKind: rollup.kind,
        countValue: Number(row.count),
        sumValue: Number(row.sum),
        distinctActors: Number(row.actors),
        computedAt: new Date(),
      })
      .orUpdate(
        ['metric_kind', 'count_value', 'sum_value', 'distinct_actors', 'computed_at'],
        ['metric_key', 'metric_day', 'scope_type', 'scope_id'],
      )
      .execute();
  }

  /** Reads a pre-aggregated series. What a dashboard should call instead of scanning facts. */
  async readSeries(
    metricKey: string,
    from: string,
    to: string,
    scope?: { type: string; id: string },
  ): Promise<Array<{ day: string; count: number; sum: number }>> {
    const rows = await this.metrics.find({
      where: {
        metricKey,
        scopeType: scope?.type ?? PLATFORM_SCOPE_TYPE,
        scopeId: scope?.id ?? PLATFORM_SCOPE_ID,
      },
      order: { metricDay: 'ASC' },
    });

    // `metricDay` is a `date` column, which TypeORM hydrates as a string --
    // but a raw query would hand back a Date, so it is normalized here rather
    // than assumed.
    const asDay = (value: string | Date): string =>
      value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

    return rows
      .filter((r) => asDay(r.metricDay) >= from && asDay(r.metricDay) <= to)
      .map((r) => ({ day: asDay(r.metricDay), count: r.countValue, sum: r.sumValue }));
  }
}
