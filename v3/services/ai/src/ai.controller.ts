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
import { IsOptional, IsString, IsInt, Min, Max, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { RequireCapability } from '@beauclick/auth';
import {
  AI_DEFAULT_PAGE_SIZE,
  AI_MAX_INPUT_CHARACTERS,
  AI_MAX_PAGE_SIZE,
} from '@beauclick/ai-contract';
import type {
  AiConversationSummary,
  AiMessageView,
  AiQuotaView,
  AiRecommendationView,
} from '@beauclick/ai-contract';

import { AiAssistantService } from './ai-assistant.service';
import { AiConsentService } from './ai-consent.service';
import { AiConversationService } from './ai-conversation.service';
import { AiQuotaService } from './ai-quota.service';
import { AiMessageEntity, AiRecommendationEntity } from './entities/ai.entities';

/**
 * The smallest coherent authenticated customer API for the assistant.
 *
 * ## The rule every route here follows, without exception
 *
 * **No route accepts an owner, customer, party, or user id.** Not in a path,
 * not in a query, not in a body. The subject is `@CurrentUser().userId`, which
 * comes from the verified JWT, and there is no DTO below with a field able to
 * name somebody else. `V3_SECURITY_MODEL.md` §3, and the same shape
 * `JourneyController` already follows.
 *
 * The one id a route does carry is a conversation's or a recommendation's, and
 * the service puts `user_id` into the WHERE clause alongside it — so another
 * customer's conversation resolves to the same 404 as one that does not exist.
 * That indistinguishability is a mandatory test, not an implementation detail:
 * distinguishing them would give a caller enumerating ids a membership oracle.
 *
 * ## What is deliberately absent
 *
 * **No operator or admin route** (`V32-DEC-009`). Not a gated one, not an
 * audited one — absent. There is no controller in this module other than this
 * one, and every route on it resolves its subject from the session, so there is
 * no code path by which anybody reads a conversation that is not theirs. The
 * test for that control is the absence itself: the route table is inspected.
 *
 * **No mutation of anything outside `ai`** (`V32-DEC-004`). Nothing here creates
 * a booking, moves money, or changes a profile, and the service it calls holds
 * no collaborator through which it could.
 *
 * ## What reaches the browser
 *
 * Enums from `@beauclick/ai-contract`, ids, counts, timestamps, and the two
 * pieces of text the customer is entitled to: their own message and the reply
 * they were shown. Never a provider key, never a raw provider response, never a
 * prompt fragment, never a cost figure, and never a private catalogue field.
 */

export class SendMessageDto {
  /**
   * Capped at the contract's limit, and the server counts the same way the page
   * does (`aiInputLength`, NFC-normalised code points).
   *
   * `class-validator`'s `@MaxLength` counts UTF-16 units, which differs from the
   * product limit for text containing astral characters. It is here as a cheap
   * outer bound that rejects an obviously-oversized body before it reaches the
   * service; the AUTHORITATIVE check is `screenCustomerInput`, which is the one
   * whose limit matches the browser's counter.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(AI_MAX_INPUT_CHARACTERS * 2)
  body!: string;
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
  @Max(AI_MAX_PAGE_SIZE)
  limit?: number;
}

@Controller('v1/me/ai')
// Applied at the CONTROLLER, not per route. A capability decorator that has to
// be repeated on every handler is one somebody eventually forgets on the
// handler that matters -- and `bc_use_ai_assistant` is required for all of
// these equally. `V32-DEC-001`: this is the customer capability, and no
// professional capability exists.
@RequireCapability('bc_use_ai_assistant')
export class AiController {
  constructor(
    private readonly assistant: AiAssistantService,
    private readonly consent: AiConsentService,
    private readonly conversations: AiConversationService,
    private readonly quota: AiQuotaService,
  ) {}

  /**
   * Whether this customer has recorded the one-time acceptance.
   *
   * Returns the contract key as well as the boolean, so a client can tell
   * "never accepted" from "accepted something else" — which is what the key
   * exists for, and which matters the day the legally-reviewed copy replaces
   * the sandbox one.
   */
  @Get('consent')
  async consentStatus(@CurrentUser() user: AuthenticatedUser) {
    const status = await this.consent.status(user.userId);
    return {
      accepted: status.accepted,
      contractKey: status.contractKey,
      acceptedAt: status.acceptedAt?.toISOString() ?? null,
    };
  }

  /**
   * Records the acceptance. Idempotent.
   *
   * Takes NO body. There is nothing for a client to supply: not the owner
   * (session), not the contract key (server-decided), and not the timestamp
   * (server clock). A body would be three opportunities to accept something on
   * somebody else's behalf, under a key nobody published, at a time that never
   * happened.
   */
  @Post('consent')
  @HttpCode(HttpStatus.OK)
  async acceptConsent(@CurrentUser() user: AuthenticatedUser) {
    const status = await this.consent.accept(user.userId);
    return {
      accepted: status.accepted,
      contractKey: status.contractKey,
      acceptedAt: status.acceptedAt?.toISOString() ?? null,
    };
  }

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  async createConversation(@CurrentUser() user: AuthenticatedUser): Promise<AiConversationSummary> {
    const conversation = await this.assistant.startConversation(user.userId);
    return toSummary(conversation);
  }

  /** Cursor-paginated. See `AiConversationService.list` for why not offset. */
  @Get('conversations')
  async listConversations(@CurrentUser() user: AuthenticatedUser, @Query() query: ListConversationsDto) {
    const { items, nextCursor } = await this.conversations.list(
      user.userId,
      query.limit ?? AI_DEFAULT_PAGE_SIZE,
      query.cursor ?? null,
    );
    return {
      items: items.map(toSummary),
      // Explicit rather than implied by an empty array: a client must be able to
      // distinguish "no more pages" from "this page happened to be empty".
      nextCursor,
    };
  }

  @Get('conversations/:id')
  async readConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
  ) {
    // The user id goes to the service, which puts it in the WHERE clause.
    // Another customer's conversation resolves to the same 404 as a nonexistent
    // one.
    const conversation = await this.conversations.readOwned(user.userId, conversationId);
    const { messages, recommendations } = await this.conversations.messagesOf(user.userId, conversationId);
    return {
      conversation: toSummary(conversation),
      messages: toMessageViews(messages, recommendations),
    };
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
    @Body() dto: SendMessageDto,
  ) {
    const result = await this.assistant.sendMessage(user.userId, conversationId, dto.body);
    const quota: AiQuotaView = {
      limit: this.quota.limit(),
      used: this.quota.limit() - result.quotaRemaining,
      remaining: result.quotaRemaining,
      resetsAt: result.quotaResetsAt.toISOString(),
    };
    return {
      conversation: toSummary(result.conversation),
      messages: toMessageViews(
        [result.customerMessage, result.assistantMessage],
        result.recommendations.map((recommendation, index) => ({
          id: `${result.assistantMessage.id}:${index}`,
          messageId: result.assistantMessage.id,
          targetType: recommendation.targetType,
          targetId: recommendation.targetId,
          displayName: recommendation.displayName,
          position: recommendation.position,
        })),
      ),
      quota,
    };
  }

  /**
   * Permanent, immediate deletion (`V32-DEC-003`).
   *
   * 204 whether or not anything was destroyed. A retry of a delete the client
   * never saw the response to must not be told the resource is missing, and a
   * foreign id must not be distinguishable from one's own — the same
   * membership-oracle reasoning the 404 above follows, arrived at from the
   * other direction.
   */
  @Delete('conversations/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
  ): Promise<void> {
    await this.conversations.destroy(user.userId, conversationId);
  }

  /**
   * Records that the customer followed a recommendation.
   *
   * Shown-then-clicked is V2's model and the right one: it measures whether the
   * assistant helped without retaining anything anybody typed. 204 regardless,
   * for the reason the delete route gives.
   */
  @Post('recommendations/:id/click')
  @HttpCode(HttpStatus.NO_CONTENT)
  async recordClick(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) recommendationId: string,
  ): Promise<void> {
    await this.assistant.recordRecommendationClick(user.userId, recommendationId);
  }
}

function toSummary(conversation: {
  id: string;
  status: AiConversationSummary['status'];
  closureReason: AiConversationSummary['closureReason'];
  messageCount: number;
  createdAt: Date;
  lastActivityAt: Date;
}): AiConversationSummary {
  return {
    id: conversation.id,
    status: conversation.status,
    closureReason: conversation.closureReason,
    messageCount: conversation.messageCount,
    startedAt: conversation.createdAt.toISOString(),
    lastActivityAt: conversation.lastActivityAt.toISOString(),
  };
}

/**
 * The projection to the browser.
 *
 * Written out field by field rather than spread, for the reason
 * `AiContextAssembler` gives about its own construction: an entity gained a
 * column and a spread would ship it. `providerKey` is on the entity and is
 * deliberately NOT here — a key is a configuration value that could one day hold
 * a vendor's name, and `providerState` answers the reader's actual question
 * without naming anything.
 */
function toMessageViews(
  messages: readonly AiMessageEntity[],
  recommendations: readonly (Pick<
    AiRecommendationEntity,
    'id' | 'messageId' | 'targetType' | 'targetId' | 'displayName' | 'position'
  >)[],
): AiMessageView[] {
  const byMessage = new Map<string, AiRecommendationView[]>();
  for (const recommendation of recommendations) {
    const existing = byMessage.get(recommendation.messageId) ?? [];
    existing.push({
      id: recommendation.id,
      targetType: recommendation.targetType,
      targetId: recommendation.targetId,
      displayName: recommendation.displayName,
      position: recommendation.position,
    });
    byMessage.set(recommendation.messageId, existing);
  }

  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    body: message.body,
    providerState: message.providerState,
    sequence: message.sequence,
    createdAt: message.createdAt.toISOString(),
    recommendations: byMessage.get(message.id) ?? [],
  }));
}
