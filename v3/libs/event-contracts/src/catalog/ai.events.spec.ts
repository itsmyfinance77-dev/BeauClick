import { z } from 'zod';

import { AI_EVENTS, AIConversationStarted, AIMessageExchanged } from './ai.events';
import { ALL_EVENT_CONTRACTS } from './index';

/**
 * The AI event contracts — ADR-030 T6, made structural.
 *
 * The rule is: **no field in an AI event may hold prose.** Not a message body,
 * not a prompt fragment, not a completion, not a display name, not a reason.
 *
 * The interesting test here is `no field accepts free text`, which walks the
 * zod schema and asserts that every string-shaped field is an enum, a uuid, or
 * a datetime — never an open `z.string()`. That makes the rule enforced by the
 * schema rather than by a reviewer noticing, and it means a future author who
 * wants to attach "just the first sentence, for debugging" has to widen a
 * schema in a file that says, in a comment, why they must not.
 *
 * This matters more here than anywhere else in the catalog. An outbox row fans
 * out to analytics, to every registered consumer, and into whatever the relay
 * logs when a dispatch fails — and an AI thread can contain a customer's stated
 * beauty and health concerns.
 */

/**
 * Walks a zod object schema and returns the fields that would accept arbitrary
 * text.
 *
 * A `z.enum([...])` is a string type and is fine: its value set is closed and
 * authored by this repository. A `z.string().uuid()` and a `z.string().datetime()`
 * are fine: an identifier and an instant are not prose. A bare `z.string()` is
 * not fine, and that is what this finds.
 */
function freeTextFields(schema: z.ZodType, path: string[] = []): string[] {
  const definition = schema as unknown as { def: { type: string; shape?: Record<string, z.ZodType>; checks?: unknown[]; innerType?: z.ZodType; entries?: unknown } };
  const def = definition.def;
  if (!def) return [];

  switch (def.type) {
    case 'object': {
      const shape = def.shape ?? {};
      return Object.entries(shape).flatMap(([key, value]) => freeTextFields(value, [...path, key]));
    }
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

describe('AI event contracts', () => {
  describe('the catalog cap', () => {
    /**
     * `V3.2_PHASE_0_DISCOVERY.md` §7.4 caps this at "at most
     * `AIConversationCreated` v1 and `AIMessageSent` v1".
     *
     * Asserted as a count so a third event is a deliberate act with a failing
     * test attached -- which is the moment somebody has to say which real
     * consumer justifies it, rather than publishing because a table changed.
     */
    it('publishes exactly two events', () => {
      expect(AI_EVENTS).toHaveLength(2);
      expect(AI_EVENTS.map((e) => e.name).sort()).toEqual(['AIConversationStarted', 'AIMessageExchanged']);
    });

    it('registers both in the platform catalog', () => {
      const names = ALL_EVENT_CONTRACTS.map((c) => c.name);
      expect(names).toContain('AIConversationStarted');
      expect(names).toContain('AIMessageExchanged');
    });

    it('names `ai` as the sole producer of both', () => {
      for (const event of AI_EVENTS) expect(event.producer).toBe('ai');
    });
  });

  describe('no field can hold prose', () => {
    it.each(AI_EVENTS.map((e) => [e.name, e] as const))('%s has no free-text field', (_name, event) => {
      expect(freeTextFields(event.schema)).toEqual([]);
    });

    /**
     * A negative control for the walker above.
     *
     * Without it, a bug in `freeTextFields` that returned `[]` for everything
     * would make the two assertions above pass vacuously -- which is the exact
     * failure mode a structural test is supposed to be immune to.
     */
    it('the detector actually detects, proved against a schema that does hold prose', () => {
      const withProse = z.object({
        conversationId: z.string().uuid(),
        messageBody: z.string(),
        nested: z.object({ note: z.string().optional() }),
      });
      expect(freeTextFields(withProse).sort()).toEqual(['messageBody', 'nested.note']);
    });
  });

  describe('the payloads, field by field', () => {
    it('AIConversationStarted carries an id, an owner, and a timestamp -- nothing else', () => {
      const shape = Object.keys((AIConversationStarted.schema as z.ZodObject<z.ZodRawShape>).shape).sort();
      expect(shape).toEqual(['conversationId', 'startedAt', 'userId']);
    });

    it('AIMessageExchanged carries counts, a length, an enum, and a latency -- never text', () => {
      const shape = Object.keys((AIMessageExchanged.schema as z.ZodObject<z.ZodRawShape>).shape).sort();
      expect(shape).toEqual([
        'conversationId',
        'droppedRecommendationCount',
        'inputLength',
        'latencyMs',
        'messageId',
        'occurredAt',
        'providerState',
        'recommendationCount',
        'userId',
      ]);
      // The input is described by its LENGTH. There is no field for the text.
      expect(shape).not.toContain('body');
      expect(shape).not.toContain('reply');
      expect(shape).not.toContain('prompt');
      expect(shape).not.toContain('completion');
    });

    /**
     * A provider KEY is a configuration value that could one day contain a
     * vendor's name, and an event payload fans out further than a log line
     * does. `providerState` answers everything a consumer needs -- whether this
     * reply came from a real language model -- without naming anything.
     */
    it('carries a provider STATE enum, never a provider key', () => {
      const shape = (AIMessageExchanged.schema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).not.toContain('providerKey');
      expect(() =>
        AIMessageExchanged.schema.parse({
          conversationId: '11111111-1111-4111-8111-111111111111',
          messageId: '22222222-2222-4222-8222-222222222222',
          userId: '33333333-3333-4333-8333-333333333333',
          providerState: 'some-vendor-name',
          inputLength: 10,
          recommendationCount: 0,
          droppedRecommendationCount: 0,
          latencyMs: 5,
          occurredAt: new Date().toISOString(),
        }),
      ).toThrow();
    });
  });

  describe('validation actually runs', () => {
    it('accepts a well-formed AIMessageExchanged payload', () => {
      expect(() =>
        AIMessageExchanged.schema.parse({
          conversationId: '11111111-1111-4111-8111-111111111111',
          messageId: '22222222-2222-4222-8222-222222222222',
          userId: '33333333-3333-4333-8333-333333333333',
          providerState: 'simulated',
          inputLength: 42,
          recommendationCount: 2,
          droppedRecommendationCount: 1,
          latencyMs: 7,
          occurredAt: '2026-08-29T10:00:00.000Z',
        }),
      ).not.toThrow();
    });

    it('rejects a negative count, which would mean an arithmetic bug upstream', () => {
      expect(() =>
        AIMessageExchanged.schema.parse({
          conversationId: '11111111-1111-4111-8111-111111111111',
          messageId: '22222222-2222-4222-8222-222222222222',
          userId: '33333333-3333-4333-8333-333333333333',
          providerState: 'simulated',
          inputLength: 42,
          recommendationCount: -1,
          droppedRecommendationCount: 0,
          latencyMs: 7,
          occurredAt: '2026-08-29T10:00:00.000Z',
        }),
      ).toThrow();
    });
  });
});
