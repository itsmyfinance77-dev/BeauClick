import { Controller, Get, Inject, Query } from '@nestjs/common';
import { IsIn, IsOptional, Matches } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { MetricsService } from './metrics.service';
import { ANALYTICS_SUBJECT_RESOLVER, AnalyticsSubjectResolverPort } from './ports';

export class RangeDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

const SERIES_EVENTS = [
  'BookingCreated',
  'BookingCompleted',
  'BookingCancelled',
  'ProviderProfileViewed',
  'OrderPaid',
  'SearchPerformed',
] as const;

export class SeriesDto extends RangeDto {
  /**
   * An allow-list, not a free string.
   *
   * `eventType` reaches a parameterised WHERE clause, so this is not about
   * injection -- it is about not turning an internal event name into a
   * public, enumerable surface. A caller probing arbitrary names would learn
   * exactly which events the platform emits.
   */
  @IsIn(SERIES_EVENTS)
  eventType!: (typeof SERIES_EVENTS)[number];
}

/**
 * A professional's own analytics.
 *
 * The isolation argument, in full:
 *
 *   1. The route has NO provider parameter. There is nothing in the URL or
 *      body that names whose analytics to return.
 *   2. The professional id is resolved from the session user via a port the
 *      composition root implements -- the same indirection Phase 2 used for
 *      the financial party resolver after GAP-05.
 *   3. A session with no professional profile gets `NotFoundOrNotYoursException`,
 *      which is byte-identical to what a nonexistent resource returns.
 *   4. `MetricsService.forProvider` filters every query on that id.
 *
 * Professional A cannot express a request for Professional B's numbers. There
 * is no parameter to tamper with, so there is no validation to forget.
 */
@Controller('v1/me/analytics')
export class MyAnalyticsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(ANALYTICS_SUBJECT_RESOLVER) private readonly subjects: AnalyticsSubjectResolverPort,
  ) {}

  @Get()
  async myAnalytics(@CurrentUser() user: AuthenticatedUser, @Query() range: RangeDto) {
    const professionalId = await this.subjects.professionalIdForUser(user.userId);
    if (!professionalId) throw new NotFoundOrNotYoursException();
    return this.metrics.forProvider(professionalId, range.from, range.to);
  }

  @Get('series')
  async mySeries(@CurrentUser() user: AuthenticatedUser, @Query() query: SeriesDto) {
    const professionalId = await this.subjects.professionalIdForUser(user.userId);
    if (!professionalId) throw new NotFoundOrNotYoursException();
    return {
      eventType: query.eventType,
      points: await this.metrics.dailySeries(query.eventType, query.from, query.to, professionalId),
    };
  }
}

/**
 * Platform-wide analytics. Capability-gated, and deliberately a SEPARATE
 * controller from the self-service one.
 *
 * Keeping the cross-party surface in its own class with its own guard is the
 * same structural choice Phase 2 made for financial: the dangerous shape is
 * never one typo away from the safe one, because they are not methods on the
 * same object.
 */
@Controller('v1/admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly metrics: MetricsService) {}

  @RequireCapability('bc_manage_platform')
  @Get()
  async platform(@Query() range: RangeDto) {
    return this.metrics.platformMetrics(range.from, range.to);
  }

  @RequireCapability('bc_manage_platform')
  @Get('series')
  async series(@Query() query: SeriesDto) {
    return {
      eventType: query.eventType,
      points: await this.metrics.dailySeries(query.eventType, query.from, query.to),
    };
  }
}
