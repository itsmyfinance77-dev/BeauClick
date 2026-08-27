import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import { RequireCapability } from '@beauclick/auth';
import { AdminAuditService, AuditAction } from '@beauclick/audit';
import { AuthenticatedUser, CurrentUser, PageQueryDto } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { NotificationCategory, NotificationEntity } from './entities/notification.entities';
import { NotificationService } from './notification.service';
import { PreferenceService } from './preference.service';
import { TemplateRegistry } from './templates/template.registry';

export class ListNotificationsDto extends PageQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unreadOnly?: boolean;
}

export class UpdatePreferencesDto {
  @IsObject()
  preferences!: Partial<Record<NotificationCategory, boolean>>;
}

/**
 * The in-app notification centre.
 *
 * Every route is scoped to the session user with no user parameter anywhere,
 * and `markRead` puts the user id in its UPDATE's WHERE clause rather than
 * fetching and comparing. Customer A asking for Customer B's notification id
 * therefore gets the same answer as asking for one that does not exist -- and
 * takes the same time doing it.
 */
@Controller('v1/me/notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: PreferenceService,
    private readonly templates: TemplateRegistry,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListNotificationsDto) {
    const page = query.page ?? 1;
    const pageSize = query.limit ?? 20;
    const { items, total } = await this.notifications.list(
      user.userId,
      pageSize,
      (page - 1) * pageSize,
      query.unreadOnly ?? false,
    );

    return {
      items: items.map((n) => this.present(n)),
      unreadCount: await this.notifications.unreadCount(user.userId),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  /**
   * The bell badge. A dedicated endpoint rather than a field on the list,
   * because the client polls this far more often than it loads the list and
   * it must not pay for a page of rows to get one number.
   */
  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { unreadCount: await this.notifications.unreadCount(user.userId) };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const marked = await this.notifications.markRead(user.userId, id);
    if (!marked) {
      // Covers three cases with one response, deliberately: not yours, does
      // not exist, and already read. Distinguishing the first two would leak
      // existence; distinguishing the third would be noise.
      //
      // The ownership question is asked directly. It used to be answered by
      // fetching a ONE-ROW page of the user's notifications and looking for
      // the id in it, so only the single most recent notification could ever
      // be recognised as owned -- re-reading any older already-read one
      // returned 404, which is the opposite of what this branch intends.
      if (!(await this.notifications.ownsNotification(user.userId, id))) {
        throw new NotFoundOrNotYoursException();
      }
    }
    return { read: true, unreadCount: await this.notifications.unreadCount(user.userId) };
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    const marked = await this.notifications.markAllRead(user.userId);
    return { marked, unreadCount: await this.notifications.unreadCount(user.userId) };
  }

  @Get('preferences')
  async getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return { preferences: await this.preferences.forUser(user.userId) };
  }

  @Patch('preferences')
  async updatePreferences(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdatePreferencesDto) {
    // The response is the TRUE state after the update, not an echo of the
    // request -- so a client that tried to disable a mandatory category can
    // see that it did not take effect.
    return { preferences: await this.preferences.update(user.userId, dto.preferences) };
  }

  /**
   * The wire shape.
   *
   * `payload` is deliberately not exposed raw; the rendered title/body is
   * produced here at read time. A template fix therefore reaches every
   * already-delivered notification, and the stored row keeps holding
   * variables rather than prose.
   */
  private present(n: NotificationEntity) {
    let title = n.templateKey;
    let body = '';
    try {
      const rendered = this.templates.render(n.templateKey, n.payload ?? {});
      title = rendered.subject;
      body = rendered.body;
    } catch {
      // A stored notification whose template has since changed incompatibly.
      // Shown with its key rather than dropped: a customer seeing a terse
      // entry is better than a gap in their history with no explanation.
      body = '';
    }

    return {
      id: n.id,
      category: n.category,
      title,
      body,
      deepLink: n.deepLink,
      read: n.readAt !== null,
      createdAt: n.createdAt,
    };
  }
}

@Controller('v1/admin/notifications')
export class NotificationAdminController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * Dead letters and channel truthfulness in one place.
   *
   * `providerVerified: false` on email/sms is surfaced through the API rather
   * than left in a document, so an operator can see that those channels are
   * not talking to a real provider without reading the source.
   */
  @RequireCapability('bc_manage_platform')
  @Get('status')
  async status(@Query() query: PageQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.limit ?? 20;
    const { items, total } = await this.notifications.deadLetters(pageSize, (page - 1) * pageSize);

    return {
      channels: this.notifications.channelStatus(),
      deadLetters: {
        total,
        items: items.map((n) => ({
          id: n.id,
          category: n.category,
          channel: n.channel,
          templateKey: n.templateKey,
          errorCode: n.errorCode,
          attempts: n.attempts,
          deadLetteredAt: n.deadLetteredAt,
        })),
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      },
    };
  }

  @RequireCapability('bc_manage_platform')
  @AuditAction('notification.retry_due_triggered', {
    transactional: false,
    because:
      'retryDue() dispatches to external channels; a PostgreSQL transaction cannot span an SMS or email send, so the audit row records that an operator triggered the sweep and how many rows it touched, not a state the database could roll back.',
  })
  @Post('retry-due')
  @HttpCode(HttpStatus.OK)
  async retryDue(@CurrentUser() user: AuthenticatedUser) {
    const result = await this.notifications.retryDue();
    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'notification.retry_due_triggered',
      targetType: 'notification_sweep',
      targetId: null,
      // The sweep's own real figures, so an operator can see what a trigger
      // actually did rather than only that it happened.
      after: { attempted: result.attempted, sent: result.sent, deadLettered: result.deadLettered },
      reason: null,
    });
    return result;
  }
}
