import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { RequireCapability } from '@beauclick/auth';
import { AdminAuditService, AuditAction } from '@beauclick/audit';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import {
  CHAT_MODERATION_ACTIONS,
  CHAT_MODERATOR_WINDOW_MESSAGES,
  CHAT_REPORT_STATUSES,
} from '@beauclick/chat-contract';
import type { ChatModerationAction, ChatReportStatus } from '@beauclick/chat-contract';

import { ChatModerationService } from './chat-moderation.service';

/**
 * The moderation surface — `V32-DEC-015`, ADR-032 §4.
 *
 * ## Three routes, one entry point
 *
 * Everything here is addressed by a **report id**. There is no route taking a
 * conversation id, a user id, a professional id, or a business id, and there is
 * no search of any kind. **That absence is the control**, and it is what the
 * suite asserts over the real route table: a moderator who wants to read a
 * conversation must first find a report about it, and a report exists only
 * because a participant filed one.
 *
 * ## What a moderator cannot do, structurally
 *
 * There is no send method, no edit method, and no delete method on this
 * controller or on `ChatModerationService`. A moderator is never a participant,
 * so `chat.messages.sender_user_id` can never hold their id — the send path
 * writes it from the authenticated session and the access check would refuse them
 * long before that.
 *
 * ## Reading is audited, not only acting
 *
 * `GET /reports/:id` carries an `@AuditAction`, exactly as the decide route does.
 * A privilege that leaves no trace when exercised is the one most worth tracing,
 * and reading a private conversation is the privilege this capability actually
 * confers — deciding is just what happens afterwards.
 *
 * `bc_moderate_chat` is in `PRIVILEGED_CAPABILITIES`, which means two things the
 * platform enforces automatically: a live revocation re-check on every request,
 * and `libs/audit`'s refusal to BOOT if a mutation gated on it declares no audit
 * action.
 */

export class ListReportsDto {
  @IsOptional()
  @IsIn([...CHAT_REPORT_STATUSES])
  status?: ChatReportStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class DecideReportDto {
  @IsIn(['upheld', 'rejected'])
  outcome!: 'upheld' | 'rejected';

  /** Required on `upheld`, refused on `rejected` — checked in the handler. */
  @IsOptional()
  @IsIn([...CHAT_MODERATION_ACTIONS])
  action?: ChatModerationAction;

  /**
   * Why. Mandatory, and it lands in the immutable audit log.
   *
   * A privileged action with no stated reason is one nobody can review later,
   * which is the whole failure `libs/audit` exists to prevent.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

@Controller('v1/admin/chat/reports')
@RequireCapability('bc_moderate_chat')
export class ChatModerationController {
  constructor(
    private readonly moderation: ChatModerationService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * The queue.
   *
   * **Metadata only — no message bodies and no report notes.** A moderator
   * triaging needs to know what kind of complaint it is and how old; reading the
   * content is a separate act against one report, and a separate audit row.
   */
  @Get()
  async list(@Query() query: ListReportsDto) {
    const reports = await this.moderation.listReports(query.status ?? 'open', query.limit ?? 50);
    return {
      items: reports.map((r) => ({
        id: r.id,
        conversationId: r.conversationId,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionAction: r.decisionAction,
        // `note` is deliberately absent. It is the reporter's prose.
      })),
    };
  }

  /**
   * The bounded window around a reported message.
   *
   * At most 50 messages. A report that does not exist, and one whose 30-day
   * post-decision access has lapsed, produce the same refusal — a moderator
   * holding a stale id learns nothing a moderator holding an invented one does
   * not.
   */
  @Get(':id')
  /**
   * A READ that writes an audit row, which is unusual and deliberate.
   *
   * `transactional: false` because there is no mutation to share a transaction
   * with -- the `because` is required by the decorator precisely so that
   * exception is argued in the source rather than assumed.
   */
  @AuditAction('chat.report.read', {
    transactional: false,
    because:
      'This route mutates nothing; it discloses a private conversation. The audit row is the record of the disclosure and has no business transaction to join.',
  })
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const found = await this.moderation.readReportedWindow(id);
    if (!found) throw new NotFoundOrNotYoursException();

    // Written before the content is returned, so a read that is served is a read
    // that is recorded -- not one that depends on the response completing.
    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'chat.report.read',
      targetType: 'chat_report',
      targetId: id,
      reason: 'Moderator opened the reported conversation window.',
      after: {
        conversationId: found.conversation.id,
        messagesVisible: found.messages.length,
        windowLimit: CHAT_MODERATOR_WINDOW_MESSAGES,
      },
    });

    return {
      report: {
        id: found.report.id,
        conversationId: found.report.conversationId,
        messageId: found.report.messageId,
        reason: found.report.reason,
        note: found.report.note,
        status: found.report.status,
        createdAt: found.report.createdAt.toISOString(),
      },
      // The window. `senderUserId` is present because a moderator judging
      // harassment has to know who said what; nothing else about either party is.
      messages: found.messages.map((m) => ({
        id: m.id,
        senderUserId: m.senderUserId,
        body: m.body,
        erased: m.erasedAt !== null,
        sequence: m.sequence,
        createdAt: m.createdAt.toISOString(),
      })),
      windowLimit: CHAT_MODERATOR_WINDOW_MESSAGES,
    };
  }

  /**
   * Decides a report.
   *
   * A second moderator deciding the same report gets the same refusal as one
   * using an invented id: `status = 'open'` is in the WHERE clause, so the loser
   * of a race does not overwrite a colleague's verdict.
   */
  @Post(':id/decide')
  @AuditAction('chat.report.decided', {
    transactional: false,
    because:
      'The decision commits in ChatModerationService.decide, which owns its own transaction; the audit row follows it rather than joining it.',
  })
  async decide(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: DecideReportDto,
  ) {
    // An action on a rejected report would be a punishment attached to a
    // complaint the moderator just dismissed.
    const action = dto.outcome === 'upheld' ? dto.action ?? 'warn_sender' : null;

    const decided = await this.moderation.decide(user.userId, id, dto.outcome, action, dto.reason);
    if (!decided) throw new NotFoundOrNotYoursException();

    await this.audit.recordDetached({
      actorUserId: user.userId,
      action: 'chat.report.decided',
      targetType: 'chat_report',
      targetId: id,
      reason: dto.reason,
      after: { status: decided.status, action: decided.decisionAction },
    });

    return {
      id: decided.id,
      status: decided.status,
      decisionAction: decided.decisionAction,
      decidedAt: decided.decidedAt?.toISOString() ?? null,
    };
  }
}
