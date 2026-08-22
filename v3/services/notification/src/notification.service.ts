import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { insertOnce, logOperation, warnOperation } from '@beauclick/events';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  NotificationDeadLettered,
  NotificationFailed,
  NotificationRead,
  NotificationRequested,
  NotificationSent,
  emitContractEvent,
} from '@beauclick/event-contracts';
import {
  NotificationCategory,
  NotificationChannel,
  NotificationEntity,
  NotificationOutboxEntity,
} from './entities/notification.entities';
import {
  NOTIFICATION_CHANNELS_TOKEN,
  NotificationChannelPort,
} from './channels/notification-channel.port';
import { PreferenceService } from './preference.service';
import { TemplateRegistry } from './templates/template.registry';

export interface NotifyInput {
  userId: string;
  templateKey: string;
  vars: Record<string, string | number>;
  entityType: string;
  entityId: string;
  channels?: NotificationChannel[];
}

export type NotifyOutcome = 'sent' | 'failed' | 'suppressed' | 'duplicate' | 'dead_lettered';

/**
 * Retry backoff, in seconds, indexed by attempt number.
 *
 * V2 re-ran every failed row on every sweep with no backoff at all, so a
 * provider outage produced a tight retry storm aimed at the thing that was
 * already struggling. The schedule below is exponential and SHORT --
 * a notification that arrives an hour late has usually lost its purpose, so
 * the point of retrying is to survive a brief blip, not to eventually deliver
 * a stale reminder.
 *
 * Its length is also the retry limit: once attempts exceeds it, the row is
 * dead-lettered rather than retried forever.
 */
const RETRY_BACKOFF_SECONDS = [30, 120, 600];

@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');
  private readonly channelsByKey: Map<string, NotificationChannelPort>;

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(NotificationEntity) private readonly notifications: Repository<NotificationEntity>,
    private readonly templates: TemplateRegistry,
    private readonly preferences: PreferenceService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
    @Inject(NOTIFICATION_CHANNELS_TOKEN) channels: NotificationChannelPort[],
  ) {
    this.channelsByKey = new Map((channels ?? []).map((c) => [c.key, c]));
  }

  /**
   * Requests a notification on one or more channels.
   *
   * The idempotency key is `{templateKey}:{entityType}:{entityId}:{userId}:{channel}`
   * -- V2's exact shape, preserved verbatim, because it is the cleanest,
   * most directly portable piece of logic the whole discovery pass found.
   *
   * The slot is RESERVED BY AN INSERT BEFORE ANY DISPATCH. That ordering is
   * the entire guarantee: two near-simultaneous requests for the same
   * notification race for one UNIQUE key, and the loser never reaches a
   * channel. Recording after sending would mean a crash between the two
   * double-sends on the next delivery of the same event.
   */
  async notify(input: NotifyInput): Promise<Record<string, NotifyOutcome>> {
    const channels = input.channels ?? ['in_app'];
    const results: Record<string, NotifyOutcome> = {};
    for (const channel of channels) {
      results[channel] = await this.dispatchOne(input, channel);
    }
    return results;
  }

  private async dispatchOne(input: NotifyInput, channel: NotificationChannel): Promise<NotifyOutcome> {
    const category = this.templates.categoryOf(input.templateKey);

    // Rendered BEFORE the row is written, so a template error fails the
    // request rather than reserving an idempotency slot that can then never
    // be delivered -- and never retried, because the slot is taken.
    const rendered = this.templates.render(input.templateKey, input.vars);
    const deepLink = this.templates.deepLinkFor(input.templateKey, input.vars);

    const enabled = await this.preferences.isEnabled(input.userId, category);
    const idempotencyKey = `${input.templateKey}:${input.entityType}:${input.entityId}:${input.userId}:${channel}`;
    const notificationId = uuidv7();

    const reserved = await this.dataSource.transaction(async (m) => {
      const won = await insertOnce(
        m
        .createQueryBuilder()
        .insert()
        .into(NotificationEntity)
        .values({
          id: notificationId,
          userId: input.userId,
          category,
          templateKey: input.templateKey,
          channel,
          payload: input.vars,
          deepLink,
          // A suppressed notification is RECORDED, not skipped: "we chose not
          // to tell them, and here is when and why" is an operationally
          // valuable fact, and it also consumes the idempotency slot so a
          // redelivery does not re-evaluate preferences and send.
          status: enabled ? 'pending' : 'suppressed',
          idempotencyKey,
          entityType: input.entityType,
          entityId: input.entityId,
          attempts: 0,
        }),
      );
      if (!won) return false;

      await emitContractEvent(this.contracts, m, NotificationOutboxEntity, NotificationRequested, {
        aggregateId: notificationId,
        payload: {
          notificationId,
          userId: input.userId,
          category,
          templateKey: input.templateKey,
          channel,
          entityType: input.entityType,
          entityId: input.entityId,
          requestedAt: new Date().toISOString(),
        },
      });
      return true;
    });

    if (!reserved) return 'duplicate';
    if (!enabled) return 'suppressed';

    return this.attemptDelivery(notificationId, channel, input.userId, category, input.templateKey, rendered, deepLink);
  }

  /**
   * One delivery attempt against a channel, recording the outcome.
   *
   * Deliberately OUTSIDE the reservation transaction. A channel call is
   * network I/O to a third party, and holding a database transaction open
   * across it would pin a connection and row locks for the duration of
   * someone else's outage -- the same reasoning that split payment
   * verification into `prepareVerification` and `applyVerification`.
   */
  private async attemptDelivery(
    notificationId: string,
    channel: NotificationChannel,
    userId: string,
    category: NotificationCategory,
    templateKey: string,
    rendered: ReturnType<TemplateRegistry['render']>,
    deepLink: string | null,
  ): Promise<NotifyOutcome> {
    const port = this.channelsByKey.get(channel);
    if (!port) {
      // An unconfigured channel is a permanent failure, not a retryable one.
      // Retrying would mean waiting for a deployment.
      return this.recordFailure(notificationId, userId, category, channel, 'channel_not_configured', false);
    }

    let result;
    try {
      result = await port.send({ notificationId, userId, channel, templateKey, rendered, deepLink });
    } catch (err) {
      // A channel that throws rather than returning a result is, by
      // definition, an unexpected condition -- treated as retryable, because
      // the alternative is dead-lettering on a transient bug.
      this.logger.error(`Channel ${channel} threw: ${err instanceof Error ? err.message : String(err)}`);
      return this.recordFailure(notificationId, userId, category, channel, 'channel_exception', true);
    }

    if (!result.delivered) {
      return this.recordFailure(
        notificationId,
        userId,
        category,
        channel,
        result.errorCode ?? 'unknown_error',
        result.retryable ?? false,
      );
    }

    return this.dataSource.transaction(async (m) => {
      // Compare-and-swap off a non-terminal status: a concurrent retry sweep
      // that also delivered must not produce a second NotificationSent.
      const update = await m
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({ status: 'sent', sentAt: new Date(), errorCode: null, nextAttemptAt: null, attempts: () => 'attempts + 1' })
        .where('id = :id AND status IN (:...open)', { id: notificationId, open: ['pending', 'failed'] })
        .execute();
      if (update.affected !== 1) return 'sent' as NotifyOutcome;

      const row = await m.getRepository(NotificationEntity).findOneOrFail({ where: { id: notificationId } });
      await emitContractEvent(this.contracts, m, NotificationOutboxEntity, NotificationSent, {
        aggregateId: notificationId,
        payload: {
          notificationId,
          userId,
          category,
          templateKey,
          channel,
          provider: port.key,
          attempts: row.attempts,
          sentAt: (row.sentAt ?? new Date()).toISOString(),
        },
      });
      logOperation(this.logger, 'notification.delivered', {
        notificationId,
        channel,
        provider: port.key,
        category,
        templateKey,
        attempts: row.attempts,
        // Whether this channel actually reaches a person. GAP-11: sms and
        // email log rather than deliver, and a log line that says "delivered"
        // without saying that is exactly the claim §16 forbids.
        providerVerified: port.providerVerified,
      });
      return 'sent' as NotifyOutcome;
    });
  }

  /**
   * Records a failed attempt, scheduling a retry or dead-lettering.
   *
   * The dead-letter decision is made HERE rather than by the sweep, so a
   * permanent failure never enters the retry set at all. A sweep that had to
   * re-derive "is this retryable" would need the channel's judgement again,
   * which it does not have.
   */
  private async recordFailure(
    notificationId: string,
    userId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
    errorCode: string,
    retryable: boolean,
  ): Promise<NotifyOutcome> {
    return this.dataSource.transaction(async (m) => {
      const repo = m.getRepository(NotificationEntity);
      const current = await repo.findOneOrFail({ where: { id: notificationId } });
      const attempts = current.attempts + 1;

      const exhausted = attempts > RETRY_BACKOFF_SECONDS.length;
      const willRetry = retryable && !exhausted;
      const nextAttemptAt = willRetry
        ? new Date(Date.now() + RETRY_BACKOFF_SECONDS[attempts - 1] * 1000)
        : null;

      await repo.update(
        { id: notificationId },
        {
          status: willRetry ? 'failed' : 'dead_lettered',
          errorCode,
          attempts,
          nextAttemptAt,
          deadLetteredAt: willRetry ? null : new Date(),
        },
      );

      await emitContractEvent(this.contracts, m, NotificationOutboxEntity, NotificationFailed, {
        aggregateId: notificationId,
        payload: { notificationId, userId, category, channel, errorCode, retryable: willRetry, attempts, failedAt: new Date().toISOString() },
      });

      if (!willRetry) {
        await emitContractEvent(this.contracts, m, NotificationOutboxEntity, NotificationDeadLettered, {
          aggregateId: notificationId,
          payload: { notificationId, userId, category, channel, errorCode, attempts, deadLetteredAt: new Date().toISOString() },
        });
        warnOperation(this.logger, 'notification.dead_lettered', {
          notificationId,
          channel,
          category,
          errorCode,
          attempts,
          // Distinguishes "the channel said never retry" from "we ran out of
          // attempts". They need different operator responses, and a single
          // dead_lettered status cannot tell them apart on its own.
          reason: retryable ? 'attempts_exhausted' : 'permanent_failure',
        });
        return 'dead_lettered' as NotifyOutcome;
      }

      warnOperation(this.logger, 'notification.retry_scheduled', {
        notificationId,
        channel,
        errorCode,
        attempts,
        retryInSeconds: RETRY_BACKOFF_SECONDS[attempts - 1],
      });
      return 'failed' as NotifyOutcome;
    });
  }

  /**
   * The retry sweep. Claims due rows and re-attempts them.
   *
   * Re-renders from the STORED VARIABLES, so a retry sends the real message.
   * V2 could not do this -- it never persisted the vars, and its own comment
   * concedes that its retry therefore sent a generic "you have a notification"
   * notice instead of the original.
   */
  async retryDue(limit = 50): Promise<{ attempted: number; sent: number; deadLettered: number }> {
    const due = await this.notifications.find({
      where: { status: 'failed', nextAttemptAt: LessThanOrEqual(new Date()) },
      order: { nextAttemptAt: 'ASC' },
      take: limit,
    });

    let sent = 0;
    let deadLettered = 0;

    for (const row of due) {
      // Claim by pushing nextAttemptAt into the future before working on the
      // row, so two concurrent sweeps cannot both retry the same
      // notification: the first wins and the second's `<= now()` no longer
      // holds.
      //
      // The predicate is `<= now()` and NOT `= :theValueWeRead`. An earlier
      // version compared the timestamp for equality against the Date loaded
      // into the entity, which never matched: PostgreSQL stores timestamptz
      // with microsecond precision and a JS Date carries milliseconds, so the
      // round-trip truncates and the equality silently fails. The sweep
      // claimed nothing, retried nothing, and reported no error -- found by a
      // real-PostgreSQL test asserting a retry actually delivers.
      const claimed = await this.notifications
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({ nextAttemptAt: () => `now() + interval '60 seconds'` })
        .where('id = :id AND status = :failed AND next_attempt_at <= now()', {
          id: row.id,
          failed: 'failed',
        })
        .execute();
      if (claimed.affected !== 1) continue;

      let rendered;
      try {
        rendered = this.templates.render(row.templateKey, row.payload ?? {});
      } catch (err) {
        // The template changed under a queued notification and its variables
        // no longer satisfy it. Permanent -- no number of retries will make
        // the stored vars match the new template.
        await this.recordFailure(row.id, row.userId, row.category, row.channel, 'template_render_failed', false);
        deadLettered += 1;
        this.logger.warn(`Notification ${row.id} render failed on retry: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const outcome = await this.attemptDelivery(
        row.id,
        row.channel,
        row.userId,
        row.category,
        row.templateKey,
        rendered,
        row.deepLink,
      );
      if (outcome === 'sent') sent += 1;
      if (outcome === 'dead_lettered') deadLettered += 1;
    }

    return { attempted: due.length, sent, deadLettered };
  }

  // -------------------------------------------------- notification centre

  async list(
    userId: string,
    limit: number,
    offset: number,
    unreadOnly: boolean,
  ): Promise<{ items: NotificationEntity[]; total: number }> {
    const where = {
      userId,
      channel: 'in_app' as NotificationChannel,
      ...(unreadOnly ? { readAt: IsNull() } : {}),
    };
    const [items, total] = await this.notifications.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  async unreadCount(userId: string): Promise<number> {
    return this.notifications.count({
      where: { userId, channel: 'in_app', readAt: IsNull(), status: 'sent' },
    });
  }

  /**
   * Marks one notification read.
   *
   * `userId` is in the WHERE clause, not checked after a fetch: another
   * customer's notification id affects zero rows and returns the same `false`
   * a nonexistent id does. There is no code path here that could reveal that
   * a given notification exists but belongs to someone else.
   */
  async markRead(userId: string, notificationId: string): Promise<boolean> {
    return this.dataSource.transaction(async (m) => {
      const result = await m
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({ readAt: new Date() })
        .where('id = :id AND user_id = :userId AND read_at IS NULL', { id: notificationId, userId })
        .execute();
      if (result.affected !== 1) return false;

      const row = await m.getRepository(NotificationEntity).findOneOrFail({ where: { id: notificationId } });
      await emitContractEvent(this.contracts, m, NotificationOutboxEntity, NotificationRead, {
        aggregateId: notificationId,
        payload: {
          notificationId,
          userId,
          category: row.category,
          readAt: (row.readAt ?? new Date()).toISOString(),
        },
      });
      return true;
    });
  }

  /**
   * Marks every unread in-app notification read.
   *
   * Deliberately does NOT emit one `NotificationRead` per row: marking 200
   * notifications read is a single user action, and 200 events would drown
   * the analytics signal it exists to provide. The count is returned instead.
   */
  async markAllRead(userId: string): Promise<number> {
    const result = await this.notifications
      .createQueryBuilder()
      .update(NotificationEntity)
      .set({ readAt: new Date() })
      .where('user_id = :userId AND channel = :channel AND read_at IS NULL', { userId, channel: 'in_app' })
      .execute();
    return result.affected ?? 0;
  }

  /** Operator visibility: what has been abandoned, and why. */
  async deadLetters(limit: number, offset: number): Promise<{ items: NotificationEntity[]; total: number }> {
    const [items, total] = await this.notifications.findAndCount({
      where: { status: 'dead_lettered' },
      order: { deadLetteredAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  channelStatus(): Array<{ channel: string; providerVerified: boolean }> {
    return Array.from(this.channelsByKey.values()).map((c) => ({
      channel: c.key,
      providerVerified: c.providerVerified,
    }));
  }

  /** Test/diagnostic seam: run something inside the service's own DataSource transaction. */
  async withTransaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(fn);
  }
}
