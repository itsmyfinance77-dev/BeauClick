import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AnalyticsEventEntity, MetricKind } from './entities/analytics.entities';
import { normalizeRange } from './platform-day';

/**
 * A metric, always carrying HOW it was derived.
 *
 * `kind` is not decoration. §26 requires that event-derived, domain-derived,
 * and correlation-derived figures stay distinguishable, and the failure mode
 * it prevents is specific: a "conversion rate" computed by dividing two
 * independently-collected counters is a CORRELATION, not a tracked funnel --
 * nothing links a particular view to a particular booking. Presenting that
 * as though it were direct tracking is the kind of quiet dishonesty that
 * survives for years because the number looks reasonable.
 */
export interface Metric {
  key: string;
  value: number;
  kind: MetricKind;
  /** Stated in the response, so the caveat travels with the figure into any report. */
  note?: string;
}

export interface ProviderMetrics {
  range: { from: string; to: string };
  funnel: {
    created: Metric;
    confirmed: Metric;
    completed: Metric;
    cancelled: Metric;
    expired: Metric;
    profileViews: Metric;
    completionRate: Metric;
    viewToBookingRate: Metric;
  };
  revenue: { paidOrders: Metric; grossToman: Metric; refundedToman: Metric };
}

/**
 * Analytics reads.
 *
 * **Professional isolation is structural.** `forProvider` takes a
 * professional id that its CALLER has resolved from the session, and every
 * query it runs is filtered on `subject_type = 'provider' AND subject_id =
 * :id`. There is no method on this class that returns another provider's
 * figures alongside a caller's own, and no method that takes a list of
 * providers -- so a controller cannot accidentally widen the scope by passing
 * the wrong argument, because there is no wider argument to pass. Same shape
 * Phase 2 gave `MyFinanceService` after GAP-05.
 *
 * Cross-party reads live on `platformMetrics`, which is capability-gated at
 * the controller and takes no party at all.
 */
@Injectable()
export class MetricsService {
  constructor(
    @InjectRepository(AnalyticsEventEntity) private readonly facts: Repository<AnalyticsEventEntity>,
  ) {}

  private async countEvents(eventType: string, from: string, to: string, subjectId?: string): Promise<number> {
    const qb = this.facts
      .createQueryBuilder('e')
      .where('e.event_type = :eventType', { eventType })
      .andWhere('e.occurred_on BETWEEN :from AND :to', { from, to });

    if (subjectId) {
      // Both columns, always together: the composite index is
      // (subject_type, subject_id, occurred_on), and filtering on the id
      // without the type would not use it.
      qb.andWhere('e.subject_type = :subjectType AND e.subject_id = :subjectId', {
        subjectType: 'provider',
        subjectId,
      });
    }

    return qb.getCount();
  }

  private async sumMetric(eventType: string, from: string, to: string, dimensionKey?: string, dimensionValue?: string): Promise<number> {
    const qb = this.facts
      .createQueryBuilder('e')
      .select('COALESCE(SUM(e.metric_value), 0)', 'total')
      .where('e.event_type = :eventType', { eventType })
      .andWhere('e.occurred_on BETWEEN :from AND :to', { from, to });

    if (dimensionKey && dimensionValue) {
      qb.andWhere('e.dimensions ->> :key = :value', { key: dimensionKey, value: dimensionValue });
    }

    const row = await qb.getRawOne<{ total: string }>();
    return Number(row?.total ?? 0);
  }

  private ratio(numerator: number, denominator: number): number {
    return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : 0;
  }

  /**
   * One professional's own analytics. Never anybody else's.
   */
  async forProvider(professionalId: string, from?: string, to?: string): Promise<ProviderMetrics> {
    const range = normalizeRange(from, to);

    const [created, confirmed, completed, cancelled, expired, profileViews] = await Promise.all([
      this.countEvents('BookingCreated', range.from, range.to, professionalId),
      this.countEvents('BookingConfirmed', range.from, range.to, professionalId),
      this.countEvents('BookingCompleted', range.from, range.to, professionalId),
      this.countEvents('BookingCancelled', range.from, range.to, professionalId),
      this.countEvents('BookingExpired', range.from, range.to, professionalId),
      this.countEvents('ProviderProfileViewed', range.from, range.to, professionalId),
    ]);

    // Order revenue is scoped by the seller dimension rather than by subject:
    // an order's SUBJECT is the order, and the professional is a dimension of
    // it. Filtering on the dimension keeps the same isolation property -- the
    // id still comes from the session, never the request.
    const [grossToman, refundedToman, paidOrders] = await Promise.all([
      this.sumMetric('OrderPaid', range.from, range.to, 'sellerPartyId', professionalId),
      this.sumMetric('OrderRefunded', range.from, range.to, 'sellerPartyId', professionalId),
      this.facts
        .createQueryBuilder('e')
        .where('e.event_type = :t', { t: 'OrderPaid' })
        .andWhere('e.occurred_on BETWEEN :from AND :to', range)
        .andWhere('e.dimensions ->> :k = :v', { k: 'sellerPartyId', v: professionalId })
        .getCount(),
    ]);

    return {
      range,
      funnel: {
        created: { key: 'bookings_created', value: created, kind: 'event_derived' },
        confirmed: { key: 'bookings_confirmed', value: confirmed, kind: 'event_derived' },
        completed: { key: 'bookings_completed', value: completed, kind: 'event_derived' },
        cancelled: { key: 'bookings_cancelled', value: cancelled, kind: 'event_derived' },
        expired: { key: 'bookings_expired', value: expired, kind: 'event_derived' },
        profileViews: { key: 'profile_views', value: profileViews, kind: 'event_derived' },
        completionRate: {
          key: 'completion_rate',
          value: this.ratio(completed, created),
          // Both halves are real, counted events about the same aggregate
          // type, so this division is a genuine funnel step.
          kind: 'event_derived',
        },
        viewToBookingRate: {
          key: 'view_to_booking_rate',
          value: this.ratio(created, profileViews),
          kind: 'correlation_derived',
          note: 'نسبت میان دو شمارنده مستقل است؛ هیچ بازدیدی به رزرو مشخصی متصل نشده است.',
        },
      },
      revenue: {
        paidOrders: { key: 'paid_orders', value: paidOrders, kind: 'event_derived' },
        grossToman: { key: 'gross_toman', value: grossToman, kind: 'event_derived' },
        refundedToman: { key: 'refunded_toman', value: refundedToman, kind: 'event_derived' },
      },
    };
  }

  /** Platform-wide figures. Capability-gated at the controller; takes no party. */
  async platformMetrics(from?: string, to?: string) {
    const range = normalizeRange(from, to);

    const [searches, emptySearches, degradedSearches, bookingsCreated, bookingsCompleted, ordersPaid] =
      await Promise.all([
        this.countEvents('SearchPerformed', range.from, range.to),
        this.facts
          .createQueryBuilder('e')
          .where('e.event_type = :t', { t: 'SearchPerformed' })
          .andWhere('e.occurred_on BETWEEN :from AND :to', range)
          .andWhere('e.metric_value = 0')
          .getCount(),
        this.facts
          .createQueryBuilder('e')
          .where('e.event_type = :t', { t: 'SearchPerformed' })
          .andWhere('e.occurred_on BETWEEN :from AND :to', range)
          .andWhere("e.dimensions ->> 'degraded' = 'true'")
          .getCount(),
        this.countEvents('BookingCreated', range.from, range.to),
        this.countEvents('BookingCompleted', range.from, range.to),
        this.countEvents('OrderPaid', range.from, range.to),
      ]);

    // Search click-through: profile views that CAME FROM a search result.
    //
    // `ProviderProfileViewed` already carries `source` ('search' | 'direct' |
    // 'journey' | 'unknown') for exactly this reason -- the contract's own note
    // calls it "the distinction that makes conversion meaningful rather than a
    // raw ratio". Nothing new is collected and no query text is involved;
    // `SearchPerformed` has no field that could carry one.
    const searchSourcedViews = await this.facts
      .createQueryBuilder('e')
      .where('e.event_type = :t', { t: 'ProviderProfileViewed' })
      .andWhere('e.occurred_on BETWEEN :from AND :to', range)
      .andWhere("e.dimensions ->> 'source' = 'search'")
      .getCount();

    const grossToman = await this.sumMetric('OrderPaid', range.from, range.to);
    const refundedToman = await this.sumMetric('OrderRefunded', range.from, range.to);

    const [notificationsSent, notificationsFailed, notificationsDeadLettered, notificationsRead] = await Promise.all([
      this.countEvents('NotificationSent', range.from, range.to),
      this.countEvents('NotificationFailed', range.from, range.to),
      this.countEvents('NotificationDeadLettered', range.from, range.to),
      this.countEvents('NotificationRead', range.from, range.to),
    ]);

    const [pointsEarned, tierChanges, membershipsActivated] = await Promise.all([
      this.sumMetric('LoyaltyPointsEarned', range.from, range.to),
      this.countEvents('LoyaltyTierChanged', range.from, range.to),
      this.countEvents('MembershipActivated', range.from, range.to),
    ]);

    return {
      range,
      search: {
        searches: { key: 'searches', value: searches, kind: 'event_derived' as MetricKind },
        emptyResultSearches: { key: 'empty_result_searches', value: emptySearches, kind: 'event_derived' as MetricKind },
        emptyResultRate: {
          key: 'empty_result_rate',
          value: this.ratio(emptySearches, searches),
          kind: 'event_derived' as MetricKind,
        },
        // A real operational signal: how often the marketplace served results
        // from the degraded fallback rather than the search engine.
        degradedSearches: { key: 'degraded_searches', value: degradedSearches, kind: 'event_derived' as MetricKind },
        searchSourcedViews: {
          key: 'search_sourced_profile_views',
          value: searchSourcedViews,
          kind: 'event_derived' as MetricKind,
        },
        clickThroughRate: {
          key: 'search_click_through_rate',
          value: this.ratio(searchSourcedViews, searches),
          // `correlation_derived`, not `event_derived`, and the distinction is
          // real: numerator and denominator are DIFFERENT event types, so a
          // single search yielding three profile views produces a rate above
          // 1.0. That is a true statement about engagement and a false one
          // about "what fraction of searches led somewhere", and the note says
          // so rather than leaving a reader to assume the friendlier reading.
          kind: 'correlation_derived' as MetricKind,
          note: 'نسبت بازدیدهای پروفایل با منشأ جست‌وجو به کل جست‌وجوها. چون یک جست‌وجو می‌تواند به چند بازدید منجر شود، این مقدار می‌تواند از ۱۰۰٪ بیشتر باشد.',
        },
      },
      bookings: {
        created: { key: 'bookings_created', value: bookingsCreated, kind: 'event_derived' as MetricKind },
        completed: { key: 'bookings_completed', value: bookingsCompleted, kind: 'event_derived' as MetricKind },
      },
      commerce: {
        ordersPaid: { key: 'orders_paid', value: ordersPaid, kind: 'event_derived' as MetricKind },
        grossToman: { key: 'gross_toman', value: grossToman, kind: 'event_derived' as MetricKind },
        refundedToman: { key: 'refunded_toman', value: refundedToman, kind: 'event_derived' as MetricKind },
      },
      notifications: {
        sent: { key: 'notifications_sent', value: notificationsSent, kind: 'event_derived' as MetricKind },
        failed: { key: 'notifications_failed', value: notificationsFailed, kind: 'event_derived' as MetricKind },
        deadLettered: { key: 'notifications_dead_lettered', value: notificationsDeadLettered, kind: 'event_derived' as MetricKind },
        read: { key: 'notifications_read', value: notificationsRead, kind: 'event_derived' as MetricKind },
        readRate: {
          key: 'notification_read_rate',
          value: this.ratio(notificationsRead, notificationsSent),
          kind: 'correlation_derived' as MetricKind,
          note: 'خوانده‌شدن فقط برای اعلان‌های درون‌برنامه‌ای قابل مشاهده است؛ ایمیل و پیامک در این نسبت شمارش می‌شوند اما هرگز خوانده‌شده ثبت نمی‌شوند.',
        },
      },
      loyalty: {
        pointsEarned: { key: 'loyalty_points_earned', value: pointsEarned, kind: 'event_derived' as MetricKind },
        tierChanges: { key: 'loyalty_tier_changes', value: tierChanges, kind: 'event_derived' as MetricKind },
        membershipsActivated: { key: 'memberships_activated', value: membershipsActivated, kind: 'event_derived' as MetricKind },
      },
    };
  }

  /** A daily time series for one event type. The shape a chart needs. */
  async dailySeries(eventType: string, from?: string, to?: string, subjectId?: string): Promise<Array<{ day: string; count: number; sum: number }>> {
    const range = normalizeRange(from, to);
    const qb = this.facts
      .createQueryBuilder('e')
      // Formatted in SQL for the same reason as the rollup: a hydrated JS
      // Date stringifies to "Thu Aug 20", not an ISO day.
      .select("TO_CHAR(e.occurred_on, 'YYYY-MM-DD')", 'day')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(e.metric_value), 0)', 'sum')
      .where('e.event_type = :eventType', { eventType })
      .andWhere('e.occurred_on BETWEEN :from AND :to', range)
      .groupBy('e.occurred_on')
      .orderBy('e.occurred_on', 'ASC');

    if (subjectId) {
      qb.andWhere('e.subject_type = :st AND e.subject_id = :sid', { st: 'provider', sid: subjectId });
    }

    const rows = await qb.getRawMany<{ day: string; count: string; sum: string }>();
    return rows.map((r) => ({ day: r.day, count: Number(r.count), sum: Number(r.sum) }));
  }
}
