import { z } from 'zod';

import { CHAT_EVENTS, ConversationStarted, MessageSent } from './chat.events';
import { ALL_EVENT_CONTRACTS } from './index';

/**
 * The chat event contracts — ADR-032 §1, made structural.
 *
 * The rule: **no field in a chat event may hold prose.** Not a message body, not
 * a preview, not a report note, not a sender's display name.
 *
 * The load-bearing test is `no field accepts free text`, which walks the zod
 * schema and rejects any string-shaped field that is not an enum, a uuid, or a
 * datetime. That makes the rule enforced by the schema rather than by a reviewer
 * noticing — and it matters because an outbox row fans out to analytics, to the
 * notification module, and into whatever the relay logs when a dispatch fails.
 */

/** Fields that would accept arbitrary text. Same walker the AI contracts use. */
function freeTextFields(schema: z.ZodType, path: string[] = []): string[] {
  const def = (schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; checks?: unknown[]; innerType?: z.ZodType } }).def;
  if (!def) return [];

  switch (def.type) {
    case 'object':
      return Object.entries(def.shape ?? {}).flatMap(([key, value]) => freeTextFields(value, [...path, key]));
    case 'optional':
    case 'nullable':
    case 'default':
      return def.innerType ? freeTextFields(def.innerType, path) : [];
    case 'array':
      return freeTextFields((def as unknown as { element: z.ZodType }).element, [...path, '[]']);
    case 'enum':
      // A closed set this repository authored. Not prose.
      return [];
    case 'string': {
      // `uuid()` and `datetime()` register checks; a bare string has none.
      const constrained = Array.isArray(def.checks) && def.checks.length > 0;
      return constrained ? [] : [path.join('.')];
    }
    default:
      return [];
  }
}

describe('chat event contracts', () => {
  describe('the catalog cap', () => {
    /**
     * `V3.2_PHASE_0_DISCOVERY.md` §8.4 caps this at two events.
     *
     * Asserted as a count so a third is a deliberate act with a failing test
     * attached — the moment somebody has to say which real consumer justifies it,
     * rather than publishing because a table changed.
     */
    it('publishes exactly two events', () => {
      expect(CHAT_EVENTS).toHaveLength(2);
      expect(CHAT_EVENTS.map((e) => e.name).sort()).toEqual(['ConversationStarted', 'MessageSent']);
    });

    it('registers both in the platform catalog', () => {
      const names = ALL_EVENT_CONTRACTS.map((c) => c.name);
      expect(names).toContain('ConversationStarted');
      expect(names).toContain('MessageSent');
    });

    it('names `chat` as the sole producer of both', () => {
      for (const event of CHAT_EVENTS) expect(event.producer).toBe('chat');
    });

    /**
     * No report or moderation event exists.
     *
     * No consumer justifies one, and a moderation event would carry the
     * reporter's free-text note. Moderation decisions live in
     * `admin.admin_audit_log`, which is immutable in a way an outbox row is not.
     */
    it('publishes no report or moderation event', () => {
      const names = ALL_EVENT_CONTRACTS.map((c) => c.name.toLowerCase());
      for (const forbidden of ['reportfiled', 'reportdecided', 'chatreport', 'chatmoderated', 'messageblocked']) {
        expect(names).not.toContain(forbidden);
      }
    });
  });

  describe('no field can hold prose', () => {
    it.each(CHAT_EVENTS.map((e) => [e.name, e] as const))('%s has no free-text field', (_name, event) => {
      expect(freeTextFields(event.schema)).toEqual([]);
    });

    /**
     * A negative control.
     *
     * Without it, a bug in the walker that returned `[]` for everything would
     * make the assertions above pass vacuously — the exact failure a structural
     * test is supposed to be immune to.
     */
    it('the detector actually detects, proved against a schema that does hold prose', () => {
      const withProse = z.object({
        conversationId: z.string().uuid(),
        preview: z.string(),
        nested: z.object({ note: z.string().optional() }),
      });
      expect(freeTextFields(withProse).sort()).toEqual(['nested.note', 'preview']);
    });
  });

  describe('the payloads, field by field', () => {
    it('ConversationStarted carries ids, a party enum, and a timestamp', () => {
      const shape = Object.keys((ConversationStarted.schema as z.ZodObject<z.ZodRawShape>).shape).sort();
      expect(shape).toEqual(['conversationId', 'counterpartyId', 'counterpartyType', 'customerUserId', 'startedAt']);
    });

    it('MessageSent carries a length and a sequence, never the text', () => {
      const shape = Object.keys((MessageSent.schema as z.ZodObject<z.ZodRawShape>).shape).sort();
      expect(shape).toEqual([
        'bodyLength',
        'conversationId',
        'messageId',
        'occurredAt',
        'recipientUserId',
        'senderUserId',
        'sequence',
      ]);
      for (const forbidden of ['body', 'text', 'preview', 'message', 'senderName', 'excerpt']) {
        expect(shape).not.toContain(forbidden);
      }
    });

    /**
     * `recipientUserId` is why the notification rule needs no enricher.
     *
     * Every other notification rule in the platform joins something at dispatch
     * time; this one does not, because the send path already knows who to notify
     * and puts it in the event.
     */
    it('carries the recipient, so notification needs no cross-domain join', () => {
      const shape = (MessageSent.schema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toContain('recipientUserId');
    });

    it('rejects a counterparty type outside commerce`s seller-party vocabulary', () => {
      expect(() =>
        ConversationStarted.schema.parse({
          conversationId: '11111111-1111-4111-8111-111111111111',
          customerUserId: '22222222-2222-4222-8222-222222222222',
          counterpartyType: 'staff',
          counterpartyId: '33333333-3333-4333-8333-333333333333',
          startedAt: '2026-08-30T10:00:00.000Z',
        }),
      ).toThrow();
    });
  });

  describe('validation actually runs', () => {
    const valid = {
      conversationId: '11111111-1111-4111-8111-111111111111',
      messageId: '22222222-2222-4222-8222-222222222222',
      senderUserId: '33333333-3333-4333-8333-333333333333',
      recipientUserId: '44444444-4444-4444-8444-444444444444',
      sequence: 7,
      bodyLength: 42,
      occurredAt: '2026-08-30T10:00:00.000Z',
    };

    it('accepts a well-formed MessageSent payload', () => {
      expect(() => MessageSent.schema.parse(valid)).not.toThrow();
    });

    it('rejects a zero sequence, which would mean an allocation bug upstream', () => {
      expect(() => MessageSent.schema.parse({ ...valid, sequence: 0 })).toThrow();
    });

    it('rejects a negative body length', () => {
      expect(() => MessageSent.schema.parse({ ...valid, bodyLength: -1 })).toThrow();
    });
  });
});
