import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { AI_MAX_INPUT_CHARACTERS, aiInputLength } from '@beauclick/ai-contract';
import type { AiProviderState } from '@beauclick/ai-contract';
import { logOperation } from '@beauclick/events';
import { MetricsRegistry } from '@beauclick/observability';
import {
  AIConversationStarted,
  AIMessageExchanged,
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  emitContractEvent,
} from '@beauclick/event-contracts';

import { AI_METRICS } from './ai.metrics';
import { AI_CLOCK, AiClock } from './ai-clock';
import { AiConsentService } from './ai-consent.service';
import { AiConversationService } from './ai-conversation.service';
import { AiQuotaService } from './ai-quota.service';
import {
  AiAssistantUnavailableException,
  AiConsentRequiredException,
  AiConversationClosedException,
  AiConversationNotFoundException,
  AiMessageTooLongException,
  AiQuotaExhaustedException,
  AiUnsafeRequestException,
} from './ai.exceptions';
import { AiContextAssembler } from './context/ai-context.assembler';
import {
  AiConversationEntity,
  AiMessageEntity,
  AiOutboxEntity,
  AiRecommendationEntity,
} from './entities/ai.entities';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { AiCompletionRequest } from './providers/ai-provider.interface';
import {
  AI_CONTEXT_HISTORY_TURNS,
  UNSAFE_REQUEST_MESSAGE,
  screenCustomerInput,
} from './safety/ai-input-safety';
import { AiOutputRejectedError, AiOutputVerifier } from './safety/ai-output-verification';

/**
 * The one path a customer message takes, and the order it takes it in.
 *
 * ```
 *   1  consent        -- refuse if the one-time acceptance is missing
 *   2  input screening -- refuse BEFORE any provider is invoked
 *   3  conversation   -- must be owned, must be open
 *   4  quota          -- reserved atomically, in the same transaction as the insert
 *   5  context        -- assembled from the four ratified sources, nothing else
 *   6  provider       -- given typed context and a deadline, and nothing else
 *   7  validate       -- shape
 *   8  verify         -- fact: every id re-resolved through the catalogue
 *   9  persist        -- two messages, N recommendations, one outbox row
 * ```
 *
 * ## Why the order is load-bearing rather than tidy
 *
 * **2 before 6** is `V3_SECURITY_MODEL.md` §5's requirement stated as control
 * flow: an injection attempt must never reach a provider. `screenCustomerInput`
 * is pure and synchronous precisely so there is nothing to await between them
 * and therefore nothing to accidentally run in parallel.
 *
 * **4 inside the transaction that does 9** closes `GAP-04`'s read-then-write
 * race. The counter and the message commit together or not at all.
 *
 * **8 after 7** is the distinction ADR-030 T3 exists to keep: validation proves
 * shape, verification proves fact, and a schema-valid response naming a
 * suspended professional passes one and fails the other.
 *
 * ## Two transactions, deliberately
 *
 * The provider call sits BETWEEN them. Holding a database transaction open
 * across a network round trip to a language model is how a connection pool dies
 * under load — a slow provider would pin one connection per waiting customer,
 * and the deadline is measured in seconds. So:
 *
 *   - transaction A reserves the quota and writes the customer's message;
 *   - the provider is called with no transaction held;
 *   - transaction B writes the reply, the recommendations, and the outbox row.
 *
 * The cost is stated rather than hidden: a crash between A and B leaves a
 * customer message with no reply and a spent quota slot. That is the correct
 * direction to fail — the alternative is either an unspent slot on a message
 * that was answered (a free bypass of the cap) or a pinned connection per
 * in-flight completion. A visible unanswered message is also something the
 * customer can act on by asking again; an invisible quota leak is not.
 *
 * ## What never happens here
 *
 * No mutation of any other domain (`V32-DEC-004`). This service holds a
 * `DataSource` scoped to its own schema's repositories, an assembler, a
 * registry, and a verifier. There is no booking service, no payment service, no
 * profile writer — nothing through which an assistant reply could become an
 * action.
 */
@Injectable()
export class AiAssistantService {
  private readonly logger = new Logger('AiAssistantService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly consent: AiConsentService,
    private readonly conversations: AiConversationService,
    private readonly quota: AiQuotaService,
    private readonly context: AiContextAssembler,
    private readonly providers: AiProviderRegistry,
    private readonly verifier: AiOutputVerifier,
    private readonly metrics: MetricsRegistry,
    @Inject(AI_CLOCK) private readonly clock: AiClock,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
    private readonly config: ConfigService,
  ) {}

  /**
   * The provider deadline, in milliseconds.
   *
   * An explicit per-request deadline is ADR-030 T7's control. Configurable
   * because a real provider's latency profile is not knowable from here;
   * defaulted low because the only registered provider is in-process and a
   * default that tolerates a hung vendor is a default that hangs customers.
   */
  private get deadlineMs(): number {
    const configured = Number(this.config.get<string>('AI_PROVIDER_TIMEOUT_MS'));
    return Number.isInteger(configured) && configured > 0 ? configured : 15_000;
  }

  /** Starts a bounded session and records the fact. */
  async startConversation(userId: string): Promise<AiConversationEntity> {
    await this.requireConsent(userId);
    const conversation = await this.conversations.create(userId);

    await this.dataSource.transaction(async (manager) => {
      await emitContractEvent(this.contracts, manager, AiOutboxEntity, AIConversationStarted, {
        aggregateId: conversation.id,
        payload: {
          conversationId: conversation.id,
          userId,
          startedAt: conversation.createdAt.toISOString(),
        },
      });
    });

    this.metrics.increment(AI_METRICS.conversations);
    return conversation;
  }

  /**
   * Sends one message and returns the reply.
   *
   * Every refusal below throws a `DomainException` carrying a closed
   * browser-safe reason and a Persian message, and none of them writes
   * anything — a refused request costs the customer nothing, which is
   * ADR-030 T5's rule about what the quota measures.
   */
  async sendMessage(
    userId: string,
    conversationId: string,
    rawBody: string,
  ): Promise<{
    conversation: AiConversationEntity;
    customerMessage: AiMessageEntity;
    assistantMessage: AiMessageEntity;
    recommendations: AiRecommendationEntity[];
    providerState: AiProviderState;
    quotaRemaining: number;
    quotaResetsAt: Date;
  }> {
    // ---- 1. consent
    await this.requireConsent(userId);

    // ---- 2. input screening, before anything else happens
    const verdict = screenCustomerInput(rawBody);
    if (verdict.outcome === 'empty' || verdict.outcome === 'too_long') {
      throw new AiMessageTooLongException(AI_MAX_INPUT_CHARACTERS);
    }
    if (verdict.outcome === 'injection' || verdict.outcome === 'private_data_request') {
      // The DISTINCTION is recorded here and nowhere the caller can see it, so
      // an operator's counter can show which is rising while a prober learns
      // only that the request was refused (ADR-030 T1).
      this.metrics.increment(AI_METRICS.refusals, { reason: verdict.outcome });
      logOperation(this.logger, 'ai.input.refused', { kind: verdict.outcome, length: aiInputLength(rawBody) });
      throw new AiUnsafeRequestException(UNSAFE_REQUEST_MESSAGE);
    }
    const body = verdict.normalized;

    const provider = this.providers.resolveDefault();
    const providerState = this.providers.stateOf(provider);

    // ---- 3, 4, 9a: ownership, openness, quota, and the customer's message,
    // all in ONE transaction. A quota slot spent on a message that was never
    // written would be a free way to burn somebody's allowance.
    const reserved = await this.dataSource.transaction(async (manager) => {
      const conversation = await this.conversations.requireOwned(manager, userId, conversationId);
      if (conversation.status !== 'active') throw new AiConversationClosedException();

      /**
       * Lock the conversation row for the rest of this transaction.
       *
       * Two things depend on it, and the first one is not obvious.
       *
       * `sequence` is `message_count + 1`, and `uq_ai_messages_sequence` makes
       * two messages claiming the same position unwritable -- which is the
       * correct constraint and exactly right. Without this lock, two concurrent
       * sends in ONE conversation both read `message_count = N`, both compute
       * `N + 1`, and the loser dies on a unique violation: a 500 where a queued
       * 201 belonged. Found by the concurrency case below, which fires
       * twenty-six simultaneous sends at one conversation.
       *
       * Locking here serialises them instead, so each waits, re-reads the
       * committed count, and takes the next position. The quota was already
       * correct without it -- the increment and the insert share this
       * transaction, so a failed insert rolled the counter back too -- but
       * "correct after an error the user sees" is not the same as correct.
       *
       * Scoped to one conversation, so it contends with nothing except that
       * conversation's own concurrent sends.
       */
      const locked: Array<{ message_count: number }> = await manager.query(
        `SELECT message_count FROM ai.conversations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [conversation.id, userId],
      );
      if (locked.length === 0) throw new AiConversationNotFoundException();
      conversation.messageCount = Number(locked[0].message_count);

      const outcome = await this.quota.consume(manager, userId, provider.respondsExternally);
      if (!outcome.allowed) {
        this.metrics.increment(AI_METRICS.refusals, { reason: 'quota_exhausted' });
        throw new AiQuotaExhaustedException(outcome.limit, outcome.resetsAt);
      }

      const now = this.clock.now();
      const sequence = conversation.messageCount + 1;
      const customerMessage = await manager.getRepository(AiMessageEntity).save(
        manager.getRepository(AiMessageEntity).create({
          id: uuidv7(),
          conversationId: conversation.id,
          userId,
          role: 'customer',
          body,
          sequence,
          providerKey: null,
          providerState: null,
        }),
      );

      // `last_activity_at` moves on an ACCEPTED message and never on a read.
      // See the entity: making it depend on browsing would make the 24-hour
      // bound a measure of attention rather than of use.
      await manager.query(
        `UPDATE ai.conversations SET message_count = $2, last_activity_at = $3, updated_at = $3 WHERE id = $1`,
        [conversation.id, sequence, now],
      );
      conversation.messageCount = sequence;
      conversation.lastActivityAt = now;

      return { conversation, customerMessage, outcome };
    });

    // ---- 5, 6, 7, 8: outside any transaction. See this class's header.
    const history = await this.recentHistory(reserved.conversation.id, userId, reserved.customerMessage.id);
    const assembled = await this.context.assemble(userId);

    const request: AiCompletionRequest = {
      message: body,
      history,
      context: assembled,
      deadlineMs: this.deadlineMs,
    };

    const startedAt = Date.now();
    let verified;
    try {
      const draft = await this.withDeadline(provider.complete(request), this.deadlineMs);
      const completion = this.verifier.validate(draft);
      verified = await this.verifier.verify(completion);
    } catch (error) {
      // ONE outcome for every provider failure: timeout, throw, and malformed
      // output all become the same Persian refusal.
      //
      // NO RETRY (ADR-030 T7). Not one, not with backoff. The only registered
      // provider is in-process and has no transport to fail transiently, and a
      // retry policy written before there is anything to retry is a policy
      // nobody has tested against real failure behaviour.
      //
      // NO SILENT SUBSTITUTION. The deterministic provider is not reached for
      // here -- that is the `F-03` mistake ADR-029 §3 exists to prevent, because
      // a user cannot tell a degraded answer from a real one.
      this.metrics.increment(AI_METRICS.providerFailures, {
        kind: error instanceof AiOutputRejectedError ? 'invalid_output' : 'unavailable',
      });
      // The issues, not the output. A validation error can quote a provider's
      // own text, which is the raw completion ADR-030 T6 keeps out of logs.
      this.logger.error(
        error instanceof AiOutputRejectedError
          ? `Provider output rejected: ${error.issues.join('; ')}`
          : 'Provider failed to answer within the deadline.',
      );
      throw new AiAssistantUnavailableException();
    }
    const latencyMs = Date.now() - startedAt;

    // ---- 9b: the reply, its recommendations, and the event.
    const persisted: AiRecommendationEntity[] = [];
    const assistantMessage = await this.dataSource.transaction(async (manager) => {
      persisted.length = 0;
      const now = this.clock.now();

      /**
       * The sequence is re-derived HERE, under the row lock, and not carried
       * from the reserving transaction.
       *
       * That transaction committed before the provider was called -- deliberately,
       * so a slow model does not pin a connection -- and the count it observed is
       * stale the moment another of this customer's sends commits. Reusing it
       * made every concurrent reply collide on `uq_ai_messages_sequence` and
       * surface as a 500, with the quota already spent by the first transaction
       * and no reply to show for it.
       *
       * Found by the concurrency case in `ai-assistant.pg-spec.ts`: twenty-six
       * simultaneous sends produced one success and a pile of internal errors.
       * The lock in the reserving transaction was necessary and not sufficient;
       * a lock has to be held by the transaction that does the write.
       */
      const locked: Array<{ message_count: number }> = await manager.query(
        `SELECT message_count FROM ai.conversations WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [reserved.conversation.id, userId],
      );
      // The conversation was destroyed between the two transactions -- the
      // customer deleted it while waiting. Their message went with it, and there
      // is nothing to attach a reply to.
      if (locked.length === 0) throw new AiConversationNotFoundException();
      const sequence = Number(locked[0].message_count) + 1;

      const message = await manager.getRepository(AiMessageEntity).save(
        manager.getRepository(AiMessageEntity).create({
          id: uuidv7(),
          conversationId: reserved.conversation.id,
          userId,
          role: 'assistant',
          body: verified.reply,
          sequence,
          providerKey: provider.key,
          // Stored per message, not derived from current configuration: a
          // conversation read months from now must still be able to say what
          // produced this paragraph, and by then the deployment may run
          // something else (`V32-DEC-008`).
          providerState,
        }),
      );

      for (const recommendation of verified.recommendations) {
        persisted.push(
          await manager.getRepository(AiRecommendationEntity).save(
          manager.getRepository(AiRecommendationEntity).create({
            id: uuidv7(),
            messageId: message.id,
            conversationId: reserved.conversation.id,
            userId,
            targetType: recommendation.targetType,
            targetId: recommendation.targetId,
            // The CATALOGUE's name, snapshotted. Never the provider's -- the
            // completion schema has no field for one.
            displayName: recommendation.displayName,
            position: recommendation.position,
            clickedAt: null,
          }),
          ),
        );
      }

      await manager.query(
        `UPDATE ai.conversations SET message_count = $2, last_activity_at = $3, updated_at = $3 WHERE id = $1`,
        [reserved.conversation.id, sequence, now],
      );
      reserved.conversation.messageCount = sequence;
      reserved.conversation.lastActivityAt = now;

      await emitContractEvent(this.contracts, manager, AiOutboxEntity, AIMessageExchanged, {
        aggregateId: reserved.conversation.id,
        payload: {
          conversationId: reserved.conversation.id,
          messageId: message.id,
          userId,
          providerState,
          // A LENGTH, never the text. The contract has no field able to hold it.
          inputLength: aiInputLength(body),
          recommendationCount: verified.recommendations.length,
          droppedRecommendationCount: verified.droppedCount,
          latencyMs,
          occurredAt: now.toISOString(),
        },
      });

      return message;
    });

    this.metrics.increment(AI_METRICS.messages, { provider_state: providerState });
    this.metrics.observe(AI_METRICS.completionDuration, latencyMs / 1000, {
      provider_state: providerState,
    });
    // Counts, enums, and latency. No text, in either direction.
    logOperation(this.logger, 'ai.message.answered', {
      providerState,
      latencyMs,
      inputLength: aiInputLength(body),
      recommendations: verified.recommendations.length,
      dropped: verified.droppedCount,
    });

    return {
      conversation: reserved.conversation,
      customerMessage: reserved.customerMessage,
      assistantMessage,
      // The PERSISTED rows, so their real ids reach the client and a click can
      // be recorded against them. Returning the pre-insert `VerifiedRecommendation`
      // values would leave the caller inventing ids, which is what the first
      // version of this did -- and the click route then answered 400 for every
      // one of them.
      recommendations: persisted,
      providerState,
      quotaRemaining: reserved.outcome.remaining,
      quotaResetsAt: reserved.outcome.resetsAt,
    };
  }

  /**
   * Records that the customer followed a recommendation.
   *
   * Scoped by `user_id`, so another customer's recommendation id is a silent
   * no-op rather than a 404 — the same membership-oracle reasoning
   * `AiConversationService.destroy` records. Idempotent: `clicked_at IS NULL`
   * in the WHERE means a double-tap does not move the timestamp, so
   * "shown then clicked" stays a measure of first use rather than of taps.
   */
  async recordRecommendationClick(userId: string, recommendationId: string): Promise<boolean> {
    const result = await this.dataSource.query(
      `UPDATE ai.recommendations SET clicked_at = $3
       WHERE id = $1 AND user_id = $2 AND clicked_at IS NULL`,
      [recommendationId, userId, this.clock.now()],
    );
    const updated = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (updated > 0) this.metrics.increment(AI_METRICS.recommendationClicks);
    return updated > 0;
  }

  private async requireConsent(userId: string): Promise<void> {
    if (!(await this.consent.hasAccepted(this.dataSource.manager, userId))) {
      this.metrics.increment(AI_METRICS.refusals, { reason: 'consent_required' });
      throw new AiConsentRequiredException();
    }
  }

  /**
   * The bounded conversation context.
   *
   * Six turns, oldest first, and the customer's just-written message excluded
   * because it travels as `request.message`. Bounded rather than complete for
   * the reason `GAP-12` records: an accumulating replay is an unbounded prompt,
   * an unbounded bill, and an unbounded injection surface, because a sentence
   * typed weeks ago would still be sent today.
   *
   * Scoped by `user_id` as well as `conversation_id`. The composite foreign key
   * already makes a cross-owner message unwritable; this makes it unreadable
   * too, so the guarantee survives a migration that drops the constraint.
   */
  private async recentHistory(
    conversationId: string,
    userId: string,
    excludeMessageId: string,
  ): Promise<{ role: 'customer' | 'assistant'; body: string }[]> {
    const rows = await this.dataSource
      .getRepository(AiMessageEntity)
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId })
      .andWhere('m.userId = :userId', { userId })
      .andWhere('m.id != :excludeMessageId', { excludeMessageId })
      .orderBy('m.sequence', 'DESC')
      .take(AI_CONTEXT_HISTORY_TURNS)
      .getMany();

    return rows.reverse().map((row) => ({ role: row.role, body: row.body }));
  }

  /**
   * The per-request deadline (ADR-030 T7).
   *
   * `Promise.race` abandons the wait; it cannot abort work already in flight,
   * and an adapter that ignores its deadline will keep running in the
   * background. That is stated rather than glossed: the guarantee here is that
   * the CUSTOMER is not left waiting, not that the provider stopped. A real
   * adapter is expected to honour `request.deadlineMs` with its own abort
   * signal, which is why the deadline is on the request as well as here.
   */
  private async withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('AI provider deadline exceeded')), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
