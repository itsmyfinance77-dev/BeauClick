import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
  SubjectTombstone,
} from '@beauclick/subject-data';

import { ChatConversationEntity, ChatMessageEntity } from './entities/chat.entities';

/**
 * `chat`'s subject-data contract — `V32-DEC-013`, ADR-032 §1.
 *
 * ## This module takes NO exception to ADR-027, and that was a decision
 *
 * ADR-027 states the platform rule: *"every module destroys free text the SUBJECT
 * authored, because prose is identifying in a way an id is not."*
 *
 * Chat is the first module where following that rule visibly costs something. A
 * conversation has two people in it, and the professional has a real interest in
 * their own business record — so V2 retained both sides, and engineering's own
 * decision packet recommended doing the same, flagged as a deliberate exception
 * needing legal sign-off.
 *
 * **The owner rejected that and chose the consistent option.** The erased
 * subject's prose is destroyed. What remains is a structural placeholder: the row
 * survives so the counterparty's own messages keep their sequence and read as a
 * conversation, and the body does not.
 *
 * That placeholder carries **no original body, no excerpt, no searchable text,
 * and nothing reconstructable** — not a ciphertext, not a hash, not a preserved
 * length. It is a gap with a sequence number, not a redaction of a known string.
 *
 * **No anonymisation claim is made anywhere in this file**, because none is
 * needed: no subject-authored prose is retained, so there is nothing whose
 * identifiability would have to be argued. That is the practical benefit of the
 * owner's choice — the weakest claim the platform has to defend is the one it
 * does not have to make.
 */
@Injectable()
export class ChatSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'chat';

  /**
   * Every physical table, claimed.
   *
   * Note that nothing here is `no_subject_data`. Every chat table carries an
   * identity column, and the column names all end in `_user_id` precisely so
   * ADR-027's coverage heuristic would REJECT a `no_subject_data` claim if
   * somebody made one — the naming and the claim agree, and the check can see
   * both.
   */
  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'chat.conversations', disposition: 'subject_data' },
    { table: 'chat.conversation_participants', disposition: 'subject_data' },
    { table: 'chat.messages', disposition: 'subject_data' },
    { table: 'chat.blocks', disposition: 'subject_data' },
    {
      table: 'chat.reports',
      disposition: 'retained',
      reason:
        'A moderation decision must stay attributable after the subject of a complaint closes their account -- the same integrity guarantee the administrative audit log carries. The reporter is tombstoned; the note is destroyed with the rest of the subject data.',
    },
    { table: 'chat.send_counters', disposition: 'subject_data' },
    { table: 'chat.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
  ];

  /**
   * Everything this module holds about the subject.
   *
   * **Only the subject's own still-existing authored messages.** Two words are
   * load-bearing:
   *
   * *Own* — the counterparty's messages are the counterparty's words, and an
   * export that included them would hand one person a copy of another's private
   * messages under the banner of a privacy right.
   *
   * *Still-existing* — a message already destroyed by an earlier erasure or by
   * the 24-month retention sweep is not resurrected for an export. The export
   * reports what is held, not what was ever held.
   */
  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const conversations = await manager
      .getRepository(ChatConversationEntity)
      .find({ where: { customerUserId: userId }, order: { createdAt: 'ASC' } });

    const messages = await manager.getRepository(ChatMessageEntity).find({
      where: { senderUserId: userId },
      order: { conversationId: 'ASC', sequence: 'ASC' },
    });

    return [
      {
        key: 'chat_conversations',
        description: 'گفتگوهای شما با ارائه‌دهندگان خدمات',
        rows: conversations.map((c) => ({
          id: c.id,
          counterpartyType: c.counterpartyType,
          counterpartyId: c.counterpartyId,
          messageCount: c.messageCount,
          startedAt: c.createdAt,
          lastMessageAt: c.lastMessageAt,
        })),
      },
      {
        key: 'chat_messages',
        description: 'پیام‌هایی که خودتان فرستاده‌اید',
        rows: messages
          // A message whose body is already gone contributes nothing. Exporting a
          // placeholder would be exporting the absence of data as if it were data.
          .filter((m) => m.body !== null)
          .map((m) => ({
            conversationId: m.conversationId,
            sequence: m.sequence,
            body: m.body,
            sentAt: m.createdAt,
          })),
      },
    ];
  }

  /**
   * Destroys this subject's prose, and the rows that are only about them.
   *
   * Four different treatments, and the differences are the substance:
   *
   * - **Messages they wrote** are stripped to a placeholder: `body = NULL`,
   *   `sender_user_id = NULL`, `erased_at` stamped. The row survives so the
   *   counterparty's side stays coherent and ordered.
   * - **Conversations where they are the customer** survive, because the
   *   counterparty's own messages are in them. The identity is already gone: the
   *   customer column keeps pointing at an identity `identity` has erased.
   * - **Blocks they created** are destroyed. A block is a live preference about
   *   the future, not a record about anybody, and it has no meaning once its
   *   author is gone.
   * - **Reports they filed** are tombstoned, not destroyed. A privileged decision
   *   must stay attributable, or the audit trail is defeated by the subject of a
   *   complaint closing their account. The free-text note goes, because it is
   *   prose the subject authored and this module destroys that.
   *
   * Runs inside the caller's transaction alongside every other module's, so a
   * failure anywhere leaves the subject fully intact rather than half erased.
   */
  async eraseSubjectData(
    manager: EntityManager,
    userId: string,
    tombstone: SubjectTombstone,
  ): Promise<SubjectErasureOutcome> {
    let anonymized = 0;
    let deleted = 0;

    /**
     * The prose. Body and author in one statement, so a row can never exist with
     * one gone and the other present -- which the schema's
     * `ck_chat_messages_erasure_paired` CHECK would refuse anyway, and which this
     * ordering means is never attempted.
     */
    const erasedMessages = await manager.query(
      `UPDATE chat.messages
          SET body = NULL, sender_user_id = NULL, erased_at = $2
        WHERE sender_user_id = $1
      RETURNING id`,
      [userId, tombstone.erasedAt],
    );
    anonymized += Array.isArray(erasedMessages) ? erasedMessages.length : 0;

    // Participant rows: the read watermark of somebody who no longer exists.
    const participants = await manager.query(
      `DELETE FROM chat.conversation_participants WHERE participant_user_id = $1`,
      [userId],
    );
    deleted += rowCount(participants);

    // Blocks in BOTH directions. A block against an erased user is as meaningless
    // as one by them.
    const blocks = await manager.query(
      `DELETE FROM chat.blocks WHERE blocker_user_id = $1 OR blocked_user_id = $1`,
      [userId],
    );
    deleted += rowCount(blocks);

    const counters = await manager.query(`DELETE FROM chat.send_counters WHERE user_id = $1`, [userId]);
    deleted += rowCount(counters);

    // Reports: tombstone the reporter, destroy the note.
    const reports = await manager.query(
      `UPDATE chat.reports SET reported_by = NULL, note = NULL WHERE reported_by = $1 RETURNING id`,
      [userId],
    );
    anonymized += Array.isArray(reports) ? reports.length : 0;

    return {
      moduleKey: this.moduleKey,
      anonymized,
      deleted,
      retained: [
        {
          table: 'chat.reports',
          reason:
            'The minimum moderation decision record survives with the reporter tombstoned and the note destroyed, so a privileged decision stays attributable.',
        },
      ],
    };
  }
}

/** `DELETE` through `manager.query` returns `[rows, count]` on the pg driver. */
function rowCount(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}
