import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import {
  CHAT_MAX_MESSAGES_PER_DAY,
  CHAT_MAX_MESSAGES_PER_MINUTE,
  CHAT_MAX_MESSAGE_CHARACTERS,
  CHAT_MAX_PAGE_SIZE,
  chatTextLength,
  isAcceptableChatMessage,
} from '@beauclick/chat-contract';
import type { ChatCounterpartyType, ChatSide } from '@beauclick/chat-contract';
import { logOperation } from '@beauclick/events';
import {
  ConversationStarted,
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  MessageSent,
  emitContractEvent,
} from '@beauclick/event-contracts';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import { CHAT_CLOCK, ChatClock, minuteBucket } from './chat-clock';
import { ChatAccessService } from './chat-access.service';
import {
  ChatBlockedException,
  ChatConversationClosedException,
  ChatMessageTooLongException,
  ChatNotEligibleException,
  ChatRateLimitedException,
  ChatSendWindowClosedException,
} from './chat.exceptions';
import {
  ChatConversationEntity,
  ChatMessageEntity,
  ChatOutboxEntity,
  ChatParticipantEntity,
} from './entities/chat.entities';
import { CHAT_SELLER_ACCESS, ChatSellerAccessPort } from './ports/chat.ports';

/**
 * Conversations and messages.
 *
 * ## The path a message takes
 *
 * ```
 *   1  screen the body            -- length, before anything is read
 *   2  load the conversation      -- readable, or an indistinguishable refusal
 *   3  re-evaluate access         -- eligibility, window, block, moderation
 *   4  lock the conversation row  -- FOR UPDATE
 *   5  reserve the throttle       -- conditional increment, same transaction
 *   6  allocate the sequence      -- from the LOCKED row, never a cached count
 *   7  insert, update, emit       -- all inside the same transaction
 * ```
 *
 * **3 is re-run on every send** and its result is never stored. `V32-DEC-011` and
 * `V32-DEC-012` both require it: a conversation row existing is not evidence that
 * sending is permitted, and the moment it becomes such evidence the 90-day window
 * stops meaning anything.
 *
 * **4, 5, 6 and 7 share one transaction, and 6 reads the locked row.** V3.2-A
 * shipped the sequence bug twice — once by reading the count without a lock, and
 * once by carrying a count across two transactions — so this module allocates the
 * sequence from the row it has just locked, in the transaction that inserts.
 * There is no second transaction here at all: unlike the AI path, nothing
 * external is called between the lock and the commit, so nothing needs to be
 * outside it.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger('ChatService');

  constructor(
    private readonly dataSource: DataSource,
    private readonly access: ChatAccessService,
    @Inject(CHAT_SELLER_ACCESS) private readonly sellerAccess: ChatSellerAccessPort,
    @Inject(CHAT_CLOCK) private readonly clock: ChatClock,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
    private readonly config: ConfigService,
  ) {}

  private num(key: string, fallback: number): number {
    const configured = Number(this.config.get<string>(key));
    return Number.isInteger(configured) && configured > 0 ? configured : fallback;
  }

  private get perMinute(): number {
    return this.num('CHAT_MAX_MESSAGES_PER_MINUTE', CHAT_MAX_MESSAGES_PER_MINUTE);
  }

  private get perDay(): number {
    return this.num('CHAT_MAX_MESSAGES_PER_DAY', CHAT_MAX_MESSAGES_PER_DAY);
  }

  // -------------------------------------------------------------------------
  // Starting a conversation
  // -------------------------------------------------------------------------

  /**
   * Starts, or returns, the one conversation between this customer and this
   * counterparty.
   *
   * **The counterparty is not supplied by the caller as a free choice** — it is
   * looked up among the caller's own eligible relationships, so a forged
   * counterparty id simply is not found and produces the same refusal as a
   * professional the caller never booked.
   *
   * `ON CONFLICT DO NOTHING` on the pair, then re-read. Two concurrent starts
   * produce one row, and the loser gets the winner's conversation rather than a
   * unique violation — which is what `V32-DEC-011`'s "many bookings collapse into
   * one conversation" means under concurrency.
   */
  async startConversation(
    customerUserId: string,
    counterpartyType: ChatCounterpartyType,
    counterpartyId: string,
  ): Promise<{ conversation: ChatConversationEntity; created: boolean }> {
    const relationship = await this.access.eligibleCounterparties(customerUserId).then((all) =>
      all.find((r) => r.counterpartyType === counterpartyType && r.counterpartyId === counterpartyId),
    );
    // No qualifying booking, a counterparty that does not exist, a booking that
    // only ever went pending -> cancelled, and a booking with no seller snapshot
    // are ALL this refusal. A caller enumerating ids learns nothing.
    if (!relationship) throw new ChatNotEligibleException();

    return this.dataSource.transaction(async (manager) => {
      const now = this.clock.now();
      const id = uuidv7();

      await manager.query(
        `INSERT INTO chat.conversations
           (id, customer_user_id, counterparty_type, counterparty_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'open', $5, $5)
         ON CONFLICT (customer_user_id, counterparty_type, counterparty_id) DO NOTHING`,
        [id, customerUserId, counterpartyType, counterpartyId, now],
      );

      const conversation = await manager.getRepository(ChatConversationEntity).findOne({
        where: { customerUserId, counterpartyType, counterpartyId },
      });
      if (!conversation) throw new NotFoundOrNotYoursException();

      const created = conversation.id === id;
      await this.access.ensureParticipant(manager, conversation, customerUserId, 'customer');

      if (created) {
        await emitContractEvent(this.contracts, manager, ChatOutboxEntity, ConversationStarted, {
          aggregateId: conversation.id,
          payload: {
            conversationId: conversation.id,
            customerUserId,
            counterpartyType,
            counterpartyId,
            startedAt: conversation.createdAt.toISOString(),
          },
        });
      }

      return { conversation, created };
    });
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  async sendMessage(
    senderUserId: string,
    conversationId: string,
    rawBody: string,
    idempotencyKey: string | null,
  ): Promise<{ message: ChatMessageEntity; conversation: ChatConversationEntity; recipients: string[] }> {
    // ---- 1. body screening, before anything is read
    const body = rawBody.normalize('NFC').trim();
    if (!isAcceptableChatMessage(body)) throw new ChatMessageTooLongException(CHAT_MAX_MESSAGE_CHARACTERS);

    return this.dataSource.transaction(async (manager) => {
      // ---- 2 and 3. readable, then re-evaluated from scratch
      const { conversation } = await this.access.requireReadable(manager, senderUserId, conversationId);
      const verdict = await this.access.evaluate(manager, senderUserId, conversation);

      if (!verdict.canSend) {
        switch (verdict.reason) {
          case 'conversation_closed':
            throw new ChatConversationClosedException();
          case 'blocked':
            throw new ChatBlockedException();
          case 'send_window_closed':
            throw new ChatSendWindowClosedException(
              90,
              this.access.sendWindowClosesAt(verdict.relationship!),
            );
          default:
            throw new ChatNotEligibleException();
        }
      }

      /**
       * An idempotent retry returns the original message.
       *
       * Checked BEFORE the throttle is charged, so a client retrying a request
       * whose response it never saw does not spend a second slot for a message
       * that already exists.
       */
      if (idempotencyKey) {
        const existing = await manager.getRepository(ChatMessageEntity).findOne({
          where: { conversationId: conversation.id, senderUserId, idempotencyKey },
        });
        if (existing) {
          const recipients = await this.access.otherSideUserIds(manager, conversation, senderUserId);
          return { message: existing, conversation, recipients };
        }
      }

      // ---- 4. lock the conversation for the rest of this transaction
      //
      // Two things depend on it. The sequence is `last_sequence + 1`, and
      // `uq_chat_messages_sequence` makes two messages claiming one position
      // unwritable -- so without the lock, concurrent sends both read N and the
      // loser dies on a unique violation: a 500 where a queued 201 belonged.
      // Locking serialises them instead. V3.2-A shipped exactly this bug.
      const locked: Array<{ last_sequence: number }> = await manager.query(
        `SELECT last_sequence FROM chat.conversations WHERE id = $1 FOR UPDATE`,
        [conversation.id],
      );
      if (locked.length === 0) throw new NotFoundOrNotYoursException();

      // ---- 5. throttle, in this transaction
      await this.reserveSendSlot(manager, senderUserId);

      // ---- 6. sequence, from the LOCKED row
      const sequence = Number(locked[0].last_sequence) + 1;
      const now = this.clock.now();

      // ---- 7. insert, update, emit
      const message = await manager.getRepository(ChatMessageEntity).save(
        manager.getRepository(ChatMessageEntity).create({
          id: uuidv7(),
          conversationId: conversation.id,
          customerUserId: conversation.customerUserId,
          senderUserId,
          body,
          erasedAt: null,
          sequence,
          idempotencyKey,
        }),
      );

      await manager.query(
        `UPDATE chat.conversations
            SET last_sequence = $2, message_count = message_count + 1,
                last_message_at = $3, updated_at = $3
          WHERE id = $1`,
        [conversation.id, sequence, now],
      );
      conversation.lastSequence = sequence;
      conversation.messageCount += 1;
      conversation.lastMessageAt = now;

      /**
       * The sender has read their own message by definition.
       *
       * Without this a sender's own send would increment their unread badge,
       * which is the kind of bug that survives review because nobody sends
       * themselves a message while testing.
       */
      await manager.query(
        `UPDATE chat.conversation_participants
            SET last_read_sequence = GREATEST(last_read_sequence, $3), updated_at = $4
          WHERE conversation_id = $1 AND participant_user_id = $2`,
        [conversation.id, senderUserId, sequence, now],
      );

      const recipients = await this.access.otherSideUserIds(manager, conversation, senderUserId);

      /**
       * One event per recipient.
       *
       * A message to a salon notifies the owner and each active manager once,
       * and each is a separate, individually idempotent notification. Carrying a
       * single `recipientUserId` per event is what lets the notification
       * consumer avoid a cross-domain join at dispatch time.
       */
      for (const recipientUserId of recipients) {
        await emitContractEvent(this.contracts, manager, ChatOutboxEntity, MessageSent, {
          aggregateId: conversation.id,
          payload: {
            conversationId: conversation.id,
            messageId: message.id,
            senderUserId,
            recipientUserId,
            sequence,
            // A LENGTH, never the text. The contract has no field able to hold it.
            bodyLength: chatTextLength(body),
            occurredAt: now.toISOString(),
          },
        });
      }

      // Counts and enums. No body, in either direction.
      logOperation(this.logger, 'chat.message.sent', {
        side: verdict.side,
        sequence,
        bodyLength: chatTextLength(body),
        recipients: recipients.length,
      });

      return { message, conversation, recipients };
    });
  }

  /**
   * Charges one send against the per-minute and per-day limits, atomically.
   *
   * A conditional `INSERT … ON CONFLICT DO UPDATE … WHERE sent_count < limit`,
   * exactly as the AI quota does, and for the same reason `GAP-04` records: a
   * read-then-write lets two concurrent sends both observe 19 and both write 20.
   *
   * **Not the HTTP throttler.** `BeauClickThrottlerGuard`'s storage is in-memory
   * per process, so its effective limit multiplies by instance count — and the
   * instance count is `THROTTLE-STORE`, still unresolved. A PostgreSQL row is
   * shared across every instance by construction. The guard still runs as coarse
   * abuse control; it is not what makes twenty mean twenty.
   */
  private async reserveSendSlot(manager: EntityManager, userId: string): Promise<void> {
    const now = this.clock.now();
    const bucket = minuteBucket(now);
    const perMinute = this.perMinute;

    const rows: Array<{ sent_count: number }> = await manager.query(
      `INSERT INTO chat.send_counters (user_id, window_start, sent_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (user_id, window_start) DO UPDATE
         SET sent_count = chat.send_counters.sent_count + 1, updated_at = now()
         WHERE chat.send_counters.sent_count < $3
       RETURNING sent_count`,
      [userId, bucket, perMinute],
    );
    if (rows.length === 0) throw new ChatRateLimitedException(perMinute, this.perDay);

    /**
     * The daily total, summed over the last 24 hours of buckets.
     *
     * Checked AFTER the minute reservation rather than before, deliberately: the
     * minute counter is the cheap conditional write and does the serialising, and
     * a caller who trips the daily cap has already been counted for the minute —
     * which is correct, because the request was accepted for rate-limiting
     * purposes even though it is refused. The alternative, reading the sum first,
     * is a read-then-write on the number that matters more.
     */
    const daily: Array<{ total: string }> = await manager.query(
      `SELECT COALESCE(SUM(sent_count), 0)::text AS total
         FROM chat.send_counters
        WHERE user_id = $1 AND window_start > $2`,
      [userId, new Date(now.getTime() - 86_400_000)],
    );
    if (Number(daily[0]?.total ?? 0) > this.perDay) throw new ChatRateLimitedException(perMinute, this.perDay);
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * A caller's inbox — every conversation they may read, on either side.
   *
   * The customer side is a column match; the seller side is whatever
   * counterparties they may currently act for. Both are unioned and ordered by
   * activity, so a professional who is also a customer sees one list.
   */
  async listConversations(
    callerUserId: string,
    limit: number,
    cursor: string | null,
  ): Promise<{ items: ChatConversationEntity[]; nextCursor: string | null }> {
    const pageSize = Math.min(Math.max(1, limit), CHAT_MAX_PAGE_SIZE);
    const decoded = cursor ? decodeConversationCursor(cursor) : null;
    const sellerParties = await this.access.sellerCounterparties(callerUserId);

    const query = this.dataSource
      .getRepository(ChatConversationEntity)
      .createQueryBuilder('c')
      .orderBy('c.lastMessageAt', 'DESC', 'NULLS LAST')
      .addOrderBy('c.id', 'DESC')
      .take(pageSize + 1);

    if (sellerParties.length === 0) {
      query.where('c.customerUserId = :callerUserId', { callerUserId });
    } else {
      // A parameterised OR over the caller's own counterparties. Never a string
      // the caller supplied -- `sellerParties` comes from the access port.
      query.where(
        `(c.customerUserId = :callerUserId OR (c.counterpartyType, c.counterpartyId) IN (:...pairs))`,
        {
          callerUserId,
          pairs: sellerParties.map((p) => [p.counterpartyType, p.counterpartyId]),
        },
      );
    }

    if (decoded) {
      query.andWhere(
        `(COALESCE(c.lastMessageAt, c.createdAt), c.id) < (:activityAt, :id)`,
        { activityAt: decoded.activityAt, id: decoded.id },
      );
    }

    const rows = await query.getMany();
    const items = rows.slice(0, pageSize);
    const last = items[items.length - 1];
    const nextCursor =
      rows.length > pageSize && last ? encodeConversationCursor(last.lastMessageAt ?? last.createdAt, last.id) : null;

    return { items, nextCursor };
  }

  /**
   * One page of messages, newest first, keyset on the sequence.
   *
   * Keyset and not offset: a retention sweep or an erasure between page one and
   * page two shifts every subsequent offset, so an offset reader silently SKIPS a
   * row. V2 used offset and had to fix an unbounded list twice.
   */
  async listMessages(
    callerUserId: string,
    conversationId: string,
    limit: number,
    beforeSequence: number | null,
  ): Promise<{ items: ChatMessageEntity[]; nextBeforeSequence: number | null; side: ChatSide }> {
    const pageSize = Math.min(Math.max(1, limit), CHAT_MAX_PAGE_SIZE);
    const { conversation, side } = await this.access.requireReadable(
      this.access.manager,
      callerUserId,
      conversationId,
    );

    const query = this.dataSource
      .getRepository(ChatMessageEntity)
      .createQueryBuilder('m')
      .where('m.conversationId = :conversationId', { conversationId: conversation.id })
      .orderBy('m.sequence', 'DESC')
      .take(pageSize + 1);

    if (beforeSequence !== null) query.andWhere('m.sequence < :beforeSequence', { beforeSequence });

    const rows = await query.getMany();
    const items = rows.slice(0, pageSize);
    const nextBeforeSequence = rows.length > pageSize && items.length > 0 ? items[items.length - 1].sequence : null;

    return { items, nextBeforeSequence, side };
  }

  /**
   * Advances the caller's read watermark.
   *
   * `GREATEST`, so it only ever increases. A client reporting a lower value is
   * ignored rather than obeyed — a watermark that can go backwards is a way to
   * make somebody else's unread badge reappear, and there is no legitimate reason
   * to un-read a message.
   */
  async markRead(callerUserId: string, conversationId: string, upToSequence: number): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const { conversation, side } = await this.access.requireReadable(manager, callerUserId, conversationId);
      await this.access.ensureParticipant(manager, conversation, callerUserId, side);

      const capped = Math.max(0, Math.min(upToSequence, conversation.lastSequence));
      await manager.query(
        `UPDATE chat.conversation_participants
            SET last_read_sequence = GREATEST(last_read_sequence, $3), last_read_at = $4, updated_at = $4
          WHERE conversation_id = $1 AND participant_user_id = $2`,
        [conversation.id, callerUserId, capped, this.clock.now()],
      );

      const row = await manager
        .getRepository(ChatParticipantEntity)
        .findOne({ where: { conversationId: conversation.id, participantUserId: callerUserId } });
      return row?.lastReadSequence ?? 0;
    });
  }

  /**
   * Unread counts for one caller.
   *
   * Computed server-side and pushed to the client rather than decremented
   * locally — the `UnreadProvider` pattern the platform already uses. A
   * participant row that does not exist yet counts as having read nothing, which
   * is why a seller who has never opened a thread sees its messages as unread.
   */
  async unreadCount(callerUserId: string): Promise<{ total: number; conversations: number }> {
    const sellerParties = await this.access.sellerCounterparties(callerUserId);
    const pairs = sellerParties.map((p) => `${p.counterpartyType}:${p.counterpartyId}`);

    const rows: Array<{ total: string; conversations: string }> = await this.dataSource.query(
      `WITH visible AS (
         SELECT c.id, c.last_sequence
           FROM chat.conversations c
          WHERE c.customer_user_id = $1
             OR (c.counterparty_type || ':' || c.counterparty_id::text) = ANY($2::text[])
       ),
       counted AS (
         SELECT v.id,
                v.last_sequence - COALESCE(p.last_read_sequence, 0) AS unread
           FROM visible v
           LEFT JOIN chat.conversation_participants p
             ON p.conversation_id = v.id AND p.participant_user_id = $1
       )
       SELECT COALESCE(SUM(GREATEST(unread, 0)), 0)::text AS total,
              COUNT(*) FILTER (WHERE unread > 0)::text AS conversations
         FROM counted`,
      [callerUserId, pairs],
    );

    return {
      total: Number(rows[0]?.total ?? 0),
      conversations: Number(rows[0]?.conversations ?? 0),
    };
  }

  /** The caller's watermarks across a set of conversations, for rendering unread badges. */
  async watermarksFor(callerUserId: string, conversationIds: string[]): Promise<Map<string, number>> {
    if (conversationIds.length === 0) return new Map();
    const rows = await this.dataSource.getRepository(ChatParticipantEntity).find({
      where: { participantUserId: callerUserId, conversationId: In(conversationIds) },
    });
    return new Map(rows.map((r) => [r.conversationId, r.lastReadSequence]));
  }
}

/**
 * The inbox cursor, opaque on purpose.
 *
 * A readable cursor invites a client to construct one, and a constructed cursor
 * pins the client to this ordering — which then cannot change without breaking
 * them.
 */
function encodeConversationCursor(activityAt: Date, id: string): string {
  return Buffer.from(`${activityAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeConversationCursor(cursor: string): { activityAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const activityAt = new Date(iso);
    // A malformed cursor is treated as ABSENT, not as an error. A client that
    // stored one across a deploy should get page one rather than a 400 it cannot
    // act on, and there is nothing to protect -- the caller comes from the
    // session either way.
    if (!id || Number.isNaN(activityAt.getTime())) return null;
    return { activityAt, id };
  } catch {
    return null;
  }
}
