import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { CHAT_SEND_WINDOW_DAYS } from '@beauclick/chat-contract';
import type { ChatCounterpartyType, ChatSide } from '@beauclick/chat-contract';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';

import { CHAT_CLOCK, ChatClock } from './chat-clock';
import {
  CHAT_ELIGIBILITY,
  CHAT_SELLER_ACCESS,
  ChatEligibilityPort,
  ChatEligibleRelationship,
  ChatSellerAccessPort,
} from './ports/chat.ports';
import { ChatBlockEntity, ChatConversationEntity, ChatParticipantEntity } from './entities/chat.entities';

/**
 * Who may do what, evaluated fresh every time.
 *
 * This service is the single place that answers "may this caller read this
 * conversation" and "may this caller send in it", and it answers both from the
 * booking relationship, the send window, blocks, and moderation state — **never
 * from a stored authorization result.**
 *
 * `V32-DEC-011` and `V32-DEC-012` both turn on that: *"existing conversation
 * state alone is never evidence of eligibility"*, and *"recompute per send; do
 * not cache the authorization result on the conversation row"*. The moment a
 * stored row can authorize a send, the 90-day window stops meaning anything —
 * because the row outlives the relationship that justified it.
 */

/** Why a caller may not send. Null when they may. */
export type ChatSendBlockReason =
  | 'not_eligible'
  | 'send_window_closed'
  | 'blocked'
  | 'conversation_closed'
  | null;

export interface ChatAccessVerdict {
  readonly canRead: boolean;
  readonly canSend: boolean;
  readonly reason: ChatSendBlockReason;
  readonly side: ChatSide | null;
  /** The relationship that justified access, when one was found. */
  readonly relationship: ChatEligibleRelationship | null;
}

@Injectable()
export class ChatAccessService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(CHAT_ELIGIBILITY) private readonly eligibility: ChatEligibilityPort,
    @Inject(CHAT_SELLER_ACCESS) private readonly sellerAccess: ChatSellerAccessPort,
    @Inject(CHAT_CLOCK) private readonly clock: ChatClock,
  ) {}

  /**
   * The instant sending closes for a relationship.
   *
   * `slot_end` plus 90 days, in absolute UTC arithmetic. No calendar boundary:
   * unlike the AI daily quota — which is a promise about a person's calendar day
   * and is therefore bucketed in Asia/Tehran — this is a duration between two
   * instants, and a timezone would add a discontinuity nobody benefits from.
   */
  sendWindowClosesAt(relationship: ChatEligibleRelationship): Date {
    return new Date(relationship.lastQualifyingSlotEnd.getTime() + CHAT_SEND_WINDOW_DAYS * 86_400_000);
  }

  /**
   * Decides what this caller may do with this conversation, right now.
   *
   * The ordering matters. Side is established first, because a caller who is
   * neither the customer nor an authorized seller reader must not learn anything
   * further — including whether the conversation is blocked or closed, both of
   * which would confirm it exists.
   */
  async evaluate(
    manager: EntityManager,
    callerUserId: string,
    conversation: ChatConversationEntity,
  ): Promise<ChatAccessVerdict> {
    const side = await this.sideOf(manager, callerUserId, conversation);
    if (side === null) {
      return { canRead: false, canSend: false, reason: null, side: null, relationship: null };
    }

    // Reading survives everything below. `V32-DEC-014` keeps history readable
    // after a block, and a moderator-closed conversation stays readable too --
    // destroying the past would let one party unilaterally erase a record the
    // other may need.
    if (conversation.closedForSendingAt !== null) {
      return { canRead: true, canSend: false, reason: 'conversation_closed', side, relationship: null };
    }

    // A block in EITHER direction refuses sending for BOTH parties (ADR-032 §2).
    // A one-way block would leave the blocker free to keep messaging somebody
    // who has signalled they want no contact.
    if (await this.blockExistsBetween(manager, conversation, callerUserId)) {
      return { canRead: true, canSend: false, reason: 'blocked', side, relationship: null };
    }

    const relationship = await this.eligibility.findRelationship(
      manager,
      conversation.customerUserId,
      conversation.counterpartyType,
      conversation.counterpartyId,
    );

    if (relationship === null) {
      // The booking that justified this conversation no longer qualifies -- it
      // was the only one and it has been re-examined, or the data changed. Read
      // stays open; sending does not.
      return { canRead: true, canSend: false, reason: 'not_eligible', side, relationship: null };
    }

    if (this.clock.now() > this.sendWindowClosesAt(relationship)) {
      return { canRead: true, canSend: false, reason: 'send_window_closed', side, relationship };
    }

    return { canRead: true, canSend: true, reason: null, side, relationship };
  }

  /**
   * Which side of the conversation this caller sits on, or null.
   *
   * The customer side is a column comparison. The seller side is a live
   * membership question asked of the composition root — a business manager
   * deactivated this morning loses the inbox on their next request, not at token
   * expiry, because nothing about their access is stored here.
   */
  async sideOf(
    manager: EntityManager,
    callerUserId: string,
    conversation: ChatConversationEntity,
  ): Promise<ChatSide | null> {
    if (conversation.customerUserId === callerUserId) return 'customer';
    const allowed = await this.sellerAccess.canAccessCounterparty(
      manager,
      callerUserId,
      conversation.counterpartyType,
      conversation.counterpartyId,
    );
    return allowed ? 'seller' : null;
  }

  /**
   * Loads a conversation the caller may read, or refuses indistinguishably.
   *
   * A conversation that does not exist, one belonging to somebody else, and one
   * the caller has no side in all produce the same
   * `NotFoundOrNotYoursException` — one type, one Persian message, already used
   * platform-wide for exactly this. Anything else is a membership oracle.
   */
  async requireReadable(
    manager: EntityManager,
    callerUserId: string,
    conversationId: string,
  ): Promise<{ conversation: ChatConversationEntity; side: ChatSide }> {
    const conversation = await manager
      .getRepository(ChatConversationEntity)
      .findOne({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundOrNotYoursException();

    const side = await this.sideOf(manager, callerUserId, conversation);
    if (side === null) throw new NotFoundOrNotYoursException();

    return { conversation, side };
  }

  /**
   * Is there a block between the two humans this conversation is between?
   *
   * "The two humans" is not the same as "the two parties". On a business-side
   * conversation the seller is whichever manager is acting, so the block check
   * is between the caller and the OTHER side's participants — resolved from the
   * participant rows plus the counterparty's current recipients, so a block
   * against one manager does not silently block a colleague.
   */
  private async blockExistsBetween(
    manager: EntityManager,
    conversation: ChatConversationEntity,
    callerUserId: string,
  ): Promise<boolean> {
    const others = await this.otherSideUserIds(manager, conversation, callerUserId);
    if (others.length === 0) return false;

    const rows = await manager.query(
      `SELECT 1 FROM chat.blocks
        WHERE (blocker_user_id = $1 AND blocked_user_id = ANY($2::uuid[]))
           OR (blocked_user_id = $1 AND blocker_user_id = ANY($2::uuid[]))
        LIMIT 1`,
      [callerUserId, others],
    );
    return rows.length > 0;
  }

  /** Everyone on the side the caller is not on. */
  async otherSideUserIds(
    manager: EntityManager,
    conversation: ChatConversationEntity,
    callerUserId: string,
  ): Promise<string[]> {
    if (conversation.customerUserId === callerUserId) {
      const recipients = await this.sellerAccess.recipientsFor(
        manager,
        conversation.counterpartyType,
        conversation.counterpartyId,
      );
      return [...recipients];
    }
    return [conversation.customerUserId];
  }

  /**
   * Ensures the caller has a participant row, creating one lazily on the seller
   * side.
   *
   * The customer's row is written at conversation creation. A seller-side row is
   * created the first time an authorized reader actually opens the thread,
   * because the set of authorized readers is a live question and materialising a
   * row per manager up front would go stale the moment somebody joins or leaves.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-write: two concurrent opens
   * by the same manager must produce one row, not a unique violation.
   */
  async ensureParticipant(
    manager: EntityManager,
    conversation: ChatConversationEntity,
    userId: string,
    side: ChatSide,
  ): Promise<ChatParticipantEntity> {
    await manager.query(
      `INSERT INTO chat.conversation_participants
         (id, conversation_id, customer_user_id, participant_user_id, side, last_read_sequence)
       VALUES ($1, $2, $3, $4, $5, 0)
       ON CONFLICT (conversation_id, participant_user_id) DO NOTHING`,
      [uuidv7(), conversation.id, conversation.customerUserId, userId, side],
    );

    const row = await manager
      .getRepository(ChatParticipantEntity)
      .findOne({ where: { conversationId: conversation.id, participantUserId: userId } });
    if (!row) throw new NotFoundOrNotYoursException();
    return row;
  }

  /** Every counterparty the caller may act for on the seller side. */
  async sellerCounterparties(
    manager: EntityManager,
    userId: string,
  ): Promise<readonly { counterpartyType: ChatCounterpartyType; counterpartyId: string }[]> {
    return this.sellerAccess.counterpartiesFor(manager, userId);
  }

  /** Every counterparty the caller may START a conversation with. */
  async eligibleCounterparties(
    manager: EntityManager,
    customerUserId: string,
  ): Promise<readonly ChatEligibleRelationship[]> {
    return this.eligibility.eligibleCounterpartiesFor(manager, customerUserId);
  }

  /** The block check, exposed for the block-creation path's own validation. */
  async blockExists(manager: EntityManager, blockerUserId: string, blockedUserId: string): Promise<boolean> {
    const row = await manager
      .getRepository(ChatBlockEntity)
      .findOne({ where: { blockerUserId, blockedUserId } });
    return row !== null;
  }

  /** The default `DataSource` manager, for read paths that hold no transaction. */
  get manager(): EntityManager {
    return this.dataSource.manager;
  }
}
