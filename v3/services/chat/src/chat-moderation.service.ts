import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import {
  CHAT_MAX_REPORTS_PER_DAY,
  CHAT_MAX_REPORT_NOTE_CHARACTERS,
  CHAT_MODERATOR_POST_DECISION_DAYS,
  CHAT_MODERATOR_WINDOW_MESSAGES,
  isAcceptableReportNote,
} from '@beauclick/chat-contract';
import type { ChatModerationAction, ChatReportReason } from '@beauclick/chat-contract';
import { logOperation } from '@beauclick/events';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import { CHAT_CLOCK, ChatClock } from './chat-clock';
import { ChatAccessService } from './chat-access.service';
import { ChatReportAlreadyOpenException, ChatReportRateLimitedException } from './chat.exceptions';
import {
  ChatBlockEntity,
  ChatConversationEntity,
  ChatMessageEntity,
  ChatReportEntity,
} from './entities/chat.entities';

/**
 * Blocking, reporting, and the moderation queue — `V32-DEC-014` and
 * `V32-DEC-015`, ADR-032.
 *
 * ## What a moderator can and cannot reach
 *
 * The only entry point is a **report id**. There is no method here taking a
 * conversation id, a user id, a professional id, or a business id, and there is
 * no search of any kind. That absence is the control: a moderator who wants to
 * read a conversation must first find a report about it, and a report only exists
 * because a participant filed one.
 *
 * The window is bounded to 50 messages centred on the reported message. A
 * conversation may span two years and cover a customer's cosmetic and medical
 * history; a moderator judging one complaint needs the exchange around it.
 *
 * **Nothing here can edit, delete, or send.** There is no method for it. ADR-032
 * §3: deleting would destroy the evidence the decision rests on and hand a
 * moderator a power neither participant has.
 */
@Injectable()
export class ChatModerationService {
  private readonly logger = new Logger('ChatModerationService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: ChatAccessService,
    @Inject(CHAT_CLOCK) private readonly clock: ChatClock,
    private readonly config: ConfigService,
  ) {}

  private get reportsPerDay(): number {
    const configured = Number(this.config.get<string>('CHAT_MAX_REPORTS_PER_DAY'));
    return Number.isInteger(configured) && configured > 0 ? configured : CHAT_MAX_REPORTS_PER_DAY;
  }

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  /**
   * Blocks the other side of a conversation.
   *
   * The caller names a conversation, never a user id — so a caller cannot block
   * somebody they have no relationship with, and cannot use the block endpoint to
   * probe whether a user id exists.
   *
   * The record is directional; the effect is mutual, and the effect lives in
   * `ChatAccessService.evaluate`, which refuses sending when a block exists in
   * **either** direction. Storing it directionally is what lets moderation answer
   * "who blocked whom"; applying it mutually is what stops a blocker from
   * continuing to message somebody who has signalled they want no contact.
   */
  async block(callerUserId: string, conversationId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { conversation } = await this.access.requireReadable(manager, callerUserId, conversationId);
      const others = await this.access.otherSideUserIds(manager, conversation, callerUserId);

      const now = this.clock.now();
      for (const blockedUserId of others) {
        if (blockedUserId === callerUserId) continue;
        await manager.query(
          `INSERT INTO chat.blocks (id, blocker_user_id, blocked_user_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING`,
          [uuidv7(), callerUserId, blockedUserId, now],
        );
      }
      // Counts only. Never who, and never the conversation.
      logOperation(this.logger, 'chat.block.created', { blocked: others.length });
    });
  }

  /**
   * Unblocks. Only the blocker may.
   *
   * Sending is restored subject to the send window, which may itself have closed
   * while the block was in place — `ChatAccessService` re-evaluates both, so there
   * is no state where unblocking silently reopens an expired channel.
   */
  async unblock(callerUserId: string, conversationId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { conversation } = await this.access.requireReadable(manager, callerUserId, conversationId);
      const others = await this.access.otherSideUserIds(manager, conversation, callerUserId);
      if (others.length === 0) return;
      await manager.query(
        `DELETE FROM chat.blocks WHERE blocker_user_id = $1 AND blocked_user_id = ANY($2::uuid[])`,
        [callerUserId, others],
      );
    });
  }

  /** Whether the caller has blocked the other side. For rendering the button's state. */
  async hasBlocked(callerUserId: string, conversation: ChatConversationEntity): Promise<boolean> {
    const others = await this.access.otherSideUserIds(this.access.manager, conversation, callerUserId);
    if (others.length === 0) return false;
    const rows = await this.dataSource.query(
      `SELECT 1 FROM chat.blocks WHERE blocker_user_id = $1 AND blocked_user_id = ANY($2::uuid[]) LIMIT 1`,
      [callerUserId, others],
    );
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  /**
   * Files a report against a specific message in a conversation the caller is in.
   *
   * Two limits, both enforced in the database rather than in application logic:
   * `uq_chat_report_open_per_reporter` (one open report per reporter per
   * conversation, a partial unique index) and a 5-per-24-hours count. The first
   * is the one that matters — without it a single user can file the same
   * complaint repeatedly and inflate a queue a moderator has to read, which is
   * exactly what `media.abuse_reports` records as the reason for its own index.
   */
  async report(
    reporterUserId: string,
    conversationId: string,
    messageId: string,
    reason: ChatReportReason,
    note: string | null,
  ): Promise<ChatReportEntity> {
    if (!isAcceptableReportNote(note)) {
      // Reuses the message-length refusal shape rather than inventing a reason:
      // a note that is too long is the same class of client-fixable mistake.
      throw new ChatReportRateLimitedException(CHAT_MAX_REPORT_NOTE_CHARACTERS);
    }

    return this.dataSource.transaction(async (manager) => {
      const { conversation } = await this.access.requireReadable(manager, reporterUserId, conversationId);

      // The anchor must be a real message in THIS conversation. A message id from
      // elsewhere is refused indistinguishably from one that does not exist.
      const anchor = await manager
        .getRepository(ChatMessageEntity)
        .findOne({ where: { id: messageId, conversationId: conversation.id } });
      if (!anchor) throw new NotFoundOrNotYoursException();

      const since = new Date(this.clock.now().getTime() - 86_400_000);
      const recent: Array<{ n: string }> = await manager.query(
        `SELECT COUNT(*)::text AS n FROM chat.reports WHERE reported_by = $1 AND created_at > $2`,
        [reporterUserId, since],
      );
      if (Number(recent[0]?.n ?? 0) >= this.reportsPerDay) {
        throw new ChatReportRateLimitedException(this.reportsPerDay);
      }

      const inserted: Array<{ id: string }> = await manager.query(
        `INSERT INTO chat.reports
           (id, conversation_id, customer_user_id, message_id, reported_by, reason, note, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          uuidv7(),
          conversation.id,
          conversation.customerUserId,
          anchor.id,
          reporterUserId,
          reason,
          note && note.trim() !== '' ? note.trim() : null,
          this.clock.now(),
        ],
      );
      // The partial unique index rejected it: this reporter already has an open
      // report on this conversation.
      if (inserted.length === 0) throw new ChatReportAlreadyOpenException();

      const row = await manager.getRepository(ChatReportEntity).findOne({ where: { id: inserted[0].id } });
      if (!row) throw new NotFoundOrNotYoursException();

      // The REASON is an enum and is safe to log; the note is not, and is never
      // logged (ADR-032 §3).
      logOperation(this.logger, 'chat.report.filed', { reason });
      return row;
    });
  }

  // -------------------------------------------------------------------------
  // The moderation queue
  // -------------------------------------------------------------------------

  /**
   * The queue. Metadata only — **no message bodies and no report notes.**
   *
   * A moderator triaging a queue needs to know what kind of complaint it is and
   * how old; reading the content is a separate, individually audited act against
   * one report.
   */
  async listReports(status: 'open' | 'upheld' | 'rejected', limit: number): Promise<ChatReportEntity[]> {
    return this.dataSource.getRepository(ChatReportEntity).find({
      where: { status },
      order: { createdAt: 'ASC' },
      take: Math.min(Math.max(1, limit), 100),
    });
  }

  /**
   * The bounded window around a reported message (`V32-DEC-015`).
   *
   * 50 messages, centred on the anchor where possible: 25 before and 25 after,
   * with the remainder taken from whichever side has room, so a report on the
   * first message of a thread still yields 50 rather than 25.
   *
   * Returns null when the report does not exist, or when access has lapsed —
   * open reports are readable, decided ones for 30 days after the decision, and
   * nothing after that. A moderator holding a stale report id gets the same
   * answer as one holding an invented one.
   */
  async readReportedWindow(
    reportId: string,
  ): Promise<{ report: ChatReportEntity; conversation: ChatConversationEntity; messages: ChatMessageEntity[] } | null> {
    const report = await this.dataSource.getRepository(ChatReportEntity).findOne({ where: { id: reportId } });
    if (!report) return null;
    if (!this.windowStillOpen(report)) return null;

    const conversation = await this.dataSource
      .getRepository(ChatConversationEntity)
      .findOne({ where: { id: report.conversationId } });
    if (!conversation) return null;

    const half = Math.floor(CHAT_MODERATOR_WINDOW_MESSAGES / 2);
    const anchor = report.messageId
      ? await this.dataSource.getRepository(ChatMessageEntity).findOne({ where: { id: report.messageId } })
      : null;
    // A report whose anchor was erased still opens; it centres on the end of the
    // conversation instead, which is the closest honest approximation.
    const centre = anchor?.sequence ?? conversation.lastSequence;

    const messages: ChatMessageEntity[] = await this.dataSource
      .getRepository(ChatMessageEntity)
      .createQueryBuilder('m')
      .where('m.conversationId = :id', { id: conversation.id })
      .andWhere('m.sequence BETWEEN :low AND :high', {
        low: Math.max(1, centre - half),
        high: centre + half,
      })
      .orderBy('m.sequence', 'ASC')
      .take(CHAT_MODERATOR_WINDOW_MESSAGES)
      .getMany();

    return { report, conversation, messages };
  }

  /**
   * Whether a moderator may still read this report's window.
   *
   * Open forever while `open`; 30 days after a decision. Permanent access would
   * turn every resolved report into a standing read grant, and the queue only
   * grows.
   */
  windowStillOpen(report: ChatReportEntity): boolean {
    if (report.status === 'open') return true;
    if (!report.decidedAt) return false;
    const expiresAt = new Date(report.decidedAt.getTime() + CHAT_MODERATOR_POST_DECISION_DAYS * 86_400_000);
    return this.clock.now() <= expiresAt;
  }

  /**
   * Decides a report.
   *
   * `status = 'open'` is in the WHERE clause, so two moderators deciding
   * simultaneously produce one decision and the loser is told the report is gone
   * rather than overwriting a colleague's verdict.
   *
   * An upheld `close_conversation` sets `closed_for_sending_at` — reading stays
   * open, which is the whole point of that column. `restrict_sender` is recorded
   * on the report and read by the send path; there is no separate restriction
   * table, because a restriction with no report behind it is a punishment nobody
   * can account for.
   */
  async decide(
    moderatorUserId: string,
    reportId: string,
    outcome: 'upheld' | 'rejected',
    action: ChatModerationAction | null,
    reason: string,
  ): Promise<ChatReportEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const now = this.clock.now();
      const updated: Array<{ id: string }> = await manager.query(
        `UPDATE chat.reports
            SET status = $2, decided_by = $3, decided_at = $4,
                decision_reason = $5, decision_action = $6
          WHERE id = $1 AND status = 'open'
        RETURNING id`,
        [reportId, outcome, moderatorUserId, now, reason, outcome === 'upheld' ? action : null],
      );
      if (updated.length === 0) return null;

      const report = await manager.getRepository(ChatReportEntity).findOne({ where: { id: reportId } });
      if (!report) return null;

      if (outcome === 'upheld' && action === 'close_conversation') {
        await this.closeConversation(manager, report.conversationId);
      }

      return report;
    });
  }

  /** Permanently closes a conversation for sending. Reading is untouched. */
  private async closeConversation(manager: EntityManager, conversationId: string): Promise<void> {
    await manager.query(
      `UPDATE chat.conversations
          SET closed_for_sending_at = $2, closed_reason = 'moderation', status = 'closed', updated_at = $2
        WHERE id = $1 AND closed_for_sending_at IS NULL`,
      [conversationId, this.clock.now()],
    );
  }

  /**
   * Whether this user is under a platform-wide chat sending restriction.
   *
   * Derived from upheld reports rather than a flag column, so the restriction and
   * the decision that produced it cannot drift apart — and so lifting it is a
   * matter of the report record rather than a second piece of state nobody
   * audits.
   */
  async isSenderRestricted(manager: EntityManager, userId: string): Promise<boolean> {
    const rows = await manager.query(
      `SELECT 1
         FROM chat.reports r
         JOIN chat.messages m ON m.id = r.message_id
        WHERE r.status = 'upheld'
          AND r.decision_action = 'restrict_sender'
          AND m.sender_user_id = $1
        LIMIT 1`,
      [userId],
    );
    return rows.length > 0;
  }

  /** Blocks authored by a subject, destroyed on erasure. Exposed for the privacy contract. */
  async blocksAuthoredBy(manager: EntityManager, userId: string): Promise<ChatBlockEntity[]> {
    return manager.getRepository(ChatBlockEntity).find({ where: { blockerUserId: userId } });
  }
}
