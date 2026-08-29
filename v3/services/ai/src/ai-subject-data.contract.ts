import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { AiConversationEntity, AiMessageEntity, AiRecommendationEntity } from './entities/ai.entities';

/**
 * `ai`'s subject-data contract (`V32-DEC-007`, ADR-027, ADR-030 T9).
 *
 * ## Erasure DELETES here, and the reasoning is not the platform default
 *
 * The platform's default is anonymization with referential integrity — keep the
 * row, destroy the identity it points at — because most rows are half of a
 * two-party fact: a booking a professional still needs, an order the ledger
 * references.
 *
 * **Nothing in `ai` is like that.** `V32-DEC-007` is explicit: *no
 * counterpart-retention exception exists for AI conversations.* An AI thread has
 * exactly one human party. The assistant is not a counterparty with an interest;
 * it is a feature of the platform, and its replies are about the subject and
 * meaningless without them. So the rows go, and applying the anonymization
 * default here out of consistency would be the wrong answer arrived at by
 * rule-following — the same conclusion `journey` reached for the same reason.
 *
 * ## The export includes the assistant's replies, and that is a decision
 *
 * `V32-DEC-007` chose alternative (a): the COMPLETE readable conversation.
 *
 * The alternative — exporting only what the subject typed — is defensible on a
 * narrow reading of "the subject's data" and produces a document nobody can
 * read: twenty questions with no answers, out of context, describing nothing.
 * The replies are not the subject's words, but they are entirely about the
 * subject, and an export that omits them satisfies the letter of a right while
 * defeating its purpose.
 *
 * ## Why `usage_daily` is `subject_data` rather than `no_subject_data`
 *
 * It carries `user_id`, so the coverage check would reject a `no_subject_data`
 * claim by name — correctly. It is a per-person record of how much they used a
 * feature on which days, which is behavioural data about an identifiable person
 * even though it holds no prose. It is exported and destroyed with everything
 * else.
 */
@Injectable()
export class AiSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'ai';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    { table: 'ai.conversations', disposition: 'subject_data' },
    { table: 'ai.messages', disposition: 'subject_data' },
    { table: 'ai.recommendations', disposition: 'subject_data' },
    { table: 'ai.assistant_consents', disposition: 'subject_data' },
    { table: 'ai.usage_daily', disposition: 'subject_data' },
    { table: 'ai.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const conversations = await manager.getRepository(AiConversationEntity).find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });

    // Ordered by conversation, then by sequence within it -- the order the
    // customer read them in. `V32-DEC-007` requires the export to be READABLE,
    // and a flat list ordered by timestamp interleaves concurrent conversations
    // into something that looks like one incoherent thread.
    const messages = await manager.getRepository(AiMessageEntity).find({
      where: { userId },
      order: { conversationId: 'ASC', sequence: 'ASC' },
    });

    const recommendations = await manager.getRepository(AiRecommendationEntity).find({
      where: { userId },
      order: { createdAt: 'ASC', position: 'ASC' },
    });

    const byMessage = new Map<string, AiRecommendationEntity[]>();
    for (const recommendation of recommendations) {
      const existing = byMessage.get(recommendation.messageId) ?? [];
      existing.push(recommendation);
      byMessage.set(recommendation.messageId, existing);
    }

    const byConversation = new Map<string, AiMessageEntity[]>();
    for (const message of messages) {
      const existing = byConversation.get(message.conversationId) ?? [];
      existing.push(message);
      byConversation.set(message.conversationId, existing);
    }

    const consent = await manager.query(
      `SELECT contract_key, accepted_at FROM ai.assistant_consents WHERE user_id = $1`,
      [userId],
    );
    const usage = await manager.query(
      `SELECT usage_day, accepted_messages, simulated_replies, external_replies
       FROM ai.usage_daily WHERE user_id = $1 ORDER BY usage_day ASC`,
      [userId],
    );

    return [
      {
        key: 'ai_conversations',
        description: 'گفتگوهای شما با دستیار هوشمند، به‌همراه پیام‌های شما و پاسخ‌های دستیار',
        rows: conversations.map((conversation) => ({
          id: conversation.id,
          status: conversation.status,
          closureReason: conversation.closureReason,
          startedAt: conversation.createdAt,
          lastActivityAt: conversation.lastActivityAt,
          closedAt: conversation.closedAt,
          messages: (byConversation.get(conversation.id) ?? []).map((message) => ({
            sequence: message.sequence,
            role: message.role,
            // The full text, in both directions. See this file's header.
            body: message.body,
            // Which kind of thing answered, so a reader of their own export can
            // tell a deterministic local reply from a language model's -- the
            // same honesty the interface owes them at the time (ADR-029 §4).
            providerState: message.providerState,
            createdAt: message.createdAt,
            recommendations: (byMessage.get(message.id) ?? []).map((recommendation) => ({
              targetType: recommendation.targetType,
              targetId: recommendation.targetId,
              displayName: recommendation.displayName,
              position: recommendation.position,
              clickedAt: recommendation.clickedAt,
            })),
          })),
        })),
      },
      {
        key: 'ai_consent',
        description: 'پذیرش شرایط استفاده از دستیار هوشمند',
        rows: Array.isArray(consent)
          ? consent.map((row: { contract_key: string; accepted_at: Date }) => ({
              contractKey: row.contract_key,
              acceptedAt: row.accepted_at,
            }))
          : [],
      },
      {
        key: 'ai_usage',
        description: 'شمار پیام‌های روزانه‌ی شما به دستیار هوشمند',
        rows: Array.isArray(usage)
          ? usage.map(
              (row: {
                usage_day: string;
                accepted_messages: number;
                simulated_replies: number;
                external_replies: number;
              }) => ({
                day: row.usage_day,
                acceptedMessages: Number(row.accepted_messages),
                simulatedReplies: Number(row.simulated_replies),
                externalReplies: Number(row.external_replies),
              }),
            )
          : [],
      },
    ];
  }

  /**
   * Destroys everything.
   *
   * `conversations` first, and the messages and recommendations follow through
   * `ON DELETE CASCADE` — one statement, so there is no window in which a
   * conversation is gone and its messages survive. The cascade's rows are
   * counted explicitly before the delete so the erasure report is honest about
   * how much was destroyed rather than reporting only the parents.
   *
   * Runs inside the caller's transaction alongside every other module's, so a
   * failure anywhere leaves the subject fully intact rather than half erased.
   */
  async eraseSubjectData(manager: EntityManager, userId: string): Promise<SubjectErasureOutcome> {
    const [messages, recommendations] = await Promise.all([
      manager.getRepository(AiMessageEntity).count({ where: { userId } }),
      manager.getRepository(AiRecommendationEntity).count({ where: { userId } }),
    ]);

    let deleted = messages + recommendations;

    // Order matters only for readability -- `usage_daily` and
    // `assistant_consents` reference nothing -- but children-first is the
    // convention the rest of the platform's erasures follow.
    for (const statement of [
      `DELETE FROM ai.conversations WHERE user_id = $1`,
      `DELETE FROM ai.assistant_consents WHERE user_id = $1`,
      `DELETE FROM ai.usage_daily WHERE user_id = $1`,
    ]) {
      const result = await manager.query(statement, [userId]);
      deleted += Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    }

    // `retained` is EMPTY, and that is the substantive claim in this file.
    // Every other module with a two-party fact reports something here. `ai` has
    // no counterpart with an interest, so nothing survives -- `V32-DEC-007`.
    return { moduleKey: this.moduleKey, anonymized: 0, deleted, retained: [] };
  }
}
