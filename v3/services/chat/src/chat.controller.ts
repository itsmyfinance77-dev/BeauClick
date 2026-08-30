import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { RequireCapability } from '@beauclick/auth';
import {
  CHAT_COUNTERPARTY_TYPES,
  CHAT_DEFAULT_PAGE_SIZE,
  CHAT_MAX_MESSAGE_CHARACTERS,
  CHAT_MAX_PAGE_SIZE,
  CHAT_MAX_REPORT_NOTE_CHARACTERS,
  CHAT_REPORT_REASONS,
} from '@beauclick/chat-contract';
import type {
  ChatConversationSummary,
  ChatCounterpartyType,
  ChatMessageView,
  ChatReportReason,
  ChatSide,
} from '@beauclick/chat-contract';

import { ChatAccessService } from './chat-access.service';
import { ChatModerationService } from './chat-moderation.service';
import { ChatService } from './chat.service';
import { ChatConversationEntity, ChatMessageEntity } from './entities/chat.entities';

/**
 * The participant API.
 *
 * ## The rule every route follows
 *
 * **No route accepts a caller-controlled customer, sender, participant, owner, or
 * user identity.** The subject is always `@CurrentUser().userId`, from the
 * verified JWT.
 *
 * A route *does* carry a counterparty type and id on `POST /conversations` — and
 * that is not an exception, because the service does not trust it: it looks the
 * pair up among the caller's **own** eligible relationships, so a forged
 * counterparty simply is not found and produces the same refusal as a
 * professional the caller has never booked. The value narrows a set the caller
 * already owns; it does not name a party.
 *
 * ## Indistinguishability
 *
 * A conversation that does not exist, one belonging to somebody else, and one the
 * caller has no side in all produce the platform's shared
 * `NotFoundOrNotYoursException` — one type, one Persian message. Anything else is
 * a membership oracle.
 */

export class StartConversationDto {
  /**
   * Which of the caller's own eligible counterparties to open a thread with.
   *
   * **Not a choice between "message the professional" and "message the salon"**
   * (`V32-DEC-010`). The counterparty is determined by the booking's historical
   * order snapshot; this field selects among the relationships the caller already
   * has, and a pair that is not among them is refused.
   */
  @IsIn([...CHAT_COUNTERPARTY_TYPES])
  counterpartyType!: ChatCounterpartyType;

  @IsUUID()
  counterpartyId!: string;
}

export class SendMessageDto {
  /**
   * The message.
   *
   * `@MaxLength` counts UTF-16 units and is a cheap outer bound only; the
   * AUTHORITATIVE check is `isAcceptableChatMessage`, which counts NFC-normalised
   * code points exactly as the browser's character counter does.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MAX_MESSAGE_CHARACTERS * 2)
  body!: string;

  /** Client-supplied. A retried POST returns the original message. */
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  idempotencyKey?: string;
}

export class ListConversationsDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CHAT_MAX_PAGE_SIZE)
  limit?: number;
}

export class ListMessagesDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CHAT_MAX_PAGE_SIZE)
  limit?: number;
}

export class MarkReadDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  upToSequence!: number;
}

export class ReportDto {
  @IsUUID()
  messageId!: string;

  @IsIn([...CHAT_REPORT_REASONS])
  reason!: ChatReportReason;

  @IsOptional()
  @IsString()
  @MaxLength(CHAT_MAX_REPORT_NOTE_CHARACTERS * 2)
  note?: string;
}

@Controller('v1/chat')
// Applied at the CONTROLLER. Every route here needs the same capability, and a
// decorator repeated per handler is one somebody eventually forgets on the
// handler that matters. (V3.2-A fixed `CapabilityGuard` to actually read
// class-level metadata; before that fix this would have silently protected
// nothing.)
@RequireCapability('bc_use_chat')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly access: ChatAccessService,
    private readonly moderation: ChatModerationService,
  ) {}

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  async start(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartConversationDto) {
    const { conversation } = await this.chat.startConversation(
      user.userId,
      dto.counterpartyType,
      dto.counterpartyId,
    );
    return this.summarise(user.userId, conversation, 0);
  }

  /** The caller's inbox — both sides, one list, cursor-paginated. */
  @Get('conversations')
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListConversationsDto) {
    const { items, nextCursor } = await this.chat.listConversations(
      user.userId,
      query.limit ?? CHAT_DEFAULT_PAGE_SIZE,
      query.cursor ?? null,
    );
    const watermarks = await this.chat.watermarksFor(user.userId, items.map((c) => c.id));

    const summaries: ChatConversationSummary[] = [];
    for (const conversation of items) {
      summaries.push(
        await this.summarise(user.userId, conversation, watermarks.get(conversation.id) ?? 0),
      );
    }
    return { items: summaries, nextCursor };
  }

  @Get('conversations/:id')
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string) {
    const { conversation } = await this.access.requireReadable(this.access.manager, user.userId, id);
    const watermarks = await this.chat.watermarksFor(user.userId, [conversation.id]);
    return this.summarise(user.userId, conversation, watermarks.get(conversation.id) ?? 0);
  }

  @Get('conversations/:id/messages')
  async messages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListMessagesDto,
  ) {
    const { items, nextBeforeSequence, side } = await this.chat.listMessages(
      user.userId,
      id,
      query.limit ?? CHAT_DEFAULT_PAGE_SIZE,
      query.before ?? null,
    );
    return {
      items: items.map((m) => toMessageView(m, user.userId, side)),
      nextBeforeSequence,
    };
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  async send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendMessageDto,
  ) {
    const { message, conversation } = await this.chat.sendMessage(
      user.userId,
      id,
      dto.body,
      dto.idempotencyKey ?? null,
    );
    const side = await this.access.sideOf(this.access.manager, user.userId, conversation);
    return {
      message: toMessageView(message, user.userId, side ?? 'customer'),
      conversation: await this.summarise(user.userId, conversation, message.sequence),
    };
  }

  @Post('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  async markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkReadDto,
  ) {
    const lastReadSequence = await this.chat.markRead(user.userId, id, dto.upToSequence);
    // The server's own count, pushed back rather than left to the client to
    // decrement. The `UnreadProvider` pattern the platform already uses.
    return { lastReadSequence, unread: await this.chat.unreadCount(user.userId) };
  }

  @Get('unread-count')
  async unread(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.unreadCount(user.userId);
  }

  /**
   * Blocks the other side of a conversation.
   *
   * Addressed by CONVERSATION, never by user id — so a caller cannot block
   * somebody they have no relationship with, and cannot use this endpoint to
   * probe whether a user id exists.
   */
  @Post('conversations/:id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  async block(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.moderation.block(user.userId, id);
  }

  @Delete('conversations/:id/block')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unblock(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.moderation.unblock(user.userId, id);
  }

  @Post('conversations/:id/report')
  @HttpCode(HttpStatus.CREATED)
  async report(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReportDto,
  ) {
    const report = await this.moderation.report(user.userId, id, dto.messageId, dto.reason, dto.note ?? null);
    return {
      id: report.id,
      conversationId: report.conversationId,
      messageId: report.messageId,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
    };
  }

  /**
   * The browser projection of a conversation.
   *
   * `canSend` is computed here, per request, from the live verdict — never read
   * off the row. A page disables its composer on this; the server refuses
   * regardless of what the page believed.
   */
  private async summarise(
    callerUserId: string,
    conversation: ChatConversationEntity,
    watermark: number,
  ): Promise<ChatConversationSummary> {
    const verdict = await this.access.evaluate(this.access.manager, callerUserId, conversation);
    return {
      id: conversation.id,
      counterpartyType: conversation.counterpartyType,
      counterpartyId: conversation.counterpartyId,
      messageCount: conversation.messageCount,
      unreadCount: Math.max(0, conversation.lastSequence - watermark),
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      startedAt: conversation.createdAt.toISOString(),
      canSend: verdict.canSend,
      cannotSendReason: verdict.reason,
      closedReason: conversation.closedReason,
    };
  }
}

/**
 * One message, as the browser receives it.
 *
 * Written field by field rather than spread: an entity gaining a column must not
 * ship it. `customerUserId` and `idempotencyKey` are on the entity and
 * deliberately absent here — the first is redundant with the conversation and the
 * second is the client's own value echoed back for no reason.
 */
export function toMessageView(
  message: ChatMessageEntity,
  callerUserId: string,
  callerSide: ChatSide,
): ChatMessageView {
  const mine = message.senderUserId !== null && message.senderUserId === callerUserId;
  return {
    id: message.id,
    senderUserId: message.senderUserId,
    // Which side wrote it, so the page can align a bubble without resolving ids.
    side: mine ? callerSide : otherSide(callerSide),
    body: message.body,
    erased: message.erasedAt !== null,
    sequence: message.sequence,
    createdAt: message.createdAt.toISOString(),
  };
}

function otherSide(side: ChatSide): ChatSide {
  return side === 'customer' ? 'seller' : 'customer';
}
