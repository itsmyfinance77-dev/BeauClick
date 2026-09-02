import { z } from 'zod';

import {
  AI_MAX_RECOMMENDATIONS_PER_REPLY,
  AI_MAX_REPLY_CHARACTERS,
  aiInputLength,
} from '@beauclick/ai-contract';

import { AiCustomerContext } from '../context/ai-context.ports';

/**
 * The provider port (ADR-029 §3).
 *
 * One interface, one registry, modelled on `PaymentProviderRegistry` — the
 * abstraction that made "nothing in V3 ever names a concrete gateway" true, and
 * which this file is trying to make equally true of "nothing in V3 ever names a
 * concrete model".
 *
 * The whole point is that adding a real vendor later is one adapter, one
 * registry entry, one configuration value, and one ledger row. No table, no
 * controller, no browser contract, and no test of the safety pipeline changes —
 * because every control (consent, quota, input screening, output validation,
 * re-verification) runs OUTSIDE this boundary and identically whichever
 * provider is selected.
 */

/**
 * What a provider is asked to do.
 *
 * Note what a provider is NOT given: a user id, a session, a database handle, a
 * repository, an `EntityManager`, or anything capable of issuing a query.
 * `V3.2_PLUS_CAPABILITY_CATALOG.md` lists raw database access and arbitrary
 * query generation for a provider as `RETIRED`, and the way that is kept is by
 * there being no parameter through which such a thing could arrive.
 *
 * `history` is the bounded conversation context. Bounded rather than complete,
 * because an accumulating replay is an unbounded prompt, an unbounded cost, and
 * an unbounded injection surface — `GAP-12`, and the reason `V32-DEC-002` chose
 * bounded sessions in the first place.
 */
export interface AiCompletionRequest {
  /** The customer's current message, already normalised and already screened. */
  readonly message: string;
  /**
   * Earlier turns in THIS conversation, oldest first, already truncated to the
   * bound. Never another conversation's, and never another customer's.
   */
  readonly history: readonly { readonly role: 'customer' | 'assistant'; readonly body: string }[];
  /** The typed, allow-listed context. See `ai-context.ports.ts`. */
  readonly context: AiCustomerContext;
  /** Milliseconds after which the caller abandons this request. */
  readonly deadlineMs: number;
}

/**
 * The response schema every provider's output is validated against.
 *
 * `zod`, because it is already the platform's schema tool (`libs/event-contracts`)
 * and because validation has to be runtime — the whole problem is that a
 * provider's output is untyped text arriving from outside the program.
 *
 * `strict()` matters: an unrecognised key is a rejection, not a field to
 * ignore. A provider that starts returning `{reply, recommendations, actions}`
 * must fail loudly here rather than have its `actions` silently dropped by a
 * permissive parse, because the day somebody adds handling for `actions` is the
 * day `V32-DEC-004`'s prohibition on AI-initiated mutation stops being
 * structural.
 *
 * The caps are on ACCEPTANCE, not truncation. An over-long reply or an
 * over-count recommendation list fails validation outright; taking a prefix
 * would normalise a misbehaving provider's output into looking correct
 * (ADR-030 T4).
 */
export const AiCompletionSchema = z
  .object({
    /**
     * The Persian text shown to the customer.
     *
     * Measured in code points via `aiInputLength`, the same function the
     * browser's character counter uses, so "2000 characters" means one thing
     * across the whole system.
     */
    reply: z
      .string()
      .min(1)
      .refine((value) => aiInputLength(value) <= AI_MAX_REPLY_CHARACTERS, {
        message: `reply exceeds ${AI_MAX_REPLY_CHARACTERS} characters`,
      }),
    /**
     * Candidate ids the provider believes are relevant.
     *
     * These are CLAIMS, not facts, and nothing downstream treats them as facts:
     * every one is re-resolved through the catalogue port before a
     * recommendation row exists (ADR-030 T3). The provider does not supply a
     * display name, deliberately — the catalogue's own name is used, so a model
     * that invents a real id and a false name gets neither.
     */
    recommendations: z
      .array(
        z
          .object({
            targetType: z.enum(['professional', 'service']),
            targetId: z.string().uuid(),
          })
          .strict(),
      )
      .max(AI_MAX_RECOMMENDATIONS_PER_REPLY),
  })
  .strict();

/** A provider's raw output, before validation. Deliberately `unknown`. */
export type AiCompletionDraft = unknown;

/** A validated completion. The only shape the domain works with. */
export type AiCompletion = z.infer<typeof AiCompletionSchema>;

/**
 * A provider adapter.
 *
 * `respondsExternally` and `mode` are the honesty fields, and they are the
 * provider's OWN statement about itself rather than something the readiness
 * surface infers. That is the same pattern `SmsProvider.deliversExternally`,
 * `ErrorReporterPort.reportsExternally`, and `MediaService.describeDriver().durable`
 * already follow — the fourth time this codebase has needed a component to
 * declare whether bytes actually leave the building, which is a strong hint that
 * it is the right shape.
 */
export interface AiAssistantProvider {
  /** Stable registry key. `deterministic` is the only one in the sandbox milestone. */
  readonly key: string;
  /** For an operator-facing list. Never shown to a customer as a model name. */
  readonly displayName: string;
  /**
   * `deterministic` — a local, in-process assistant. No network, no credential,
   * no external cost, and not a language model.
   * `external` — a real provider. Nothing in V3.2-A returns this.
   */
  readonly mode: 'deterministic' | 'external';
  /** Whether a request to this provider leaves the process. */
  readonly respondsExternally: boolean;

  /**
   * Produces a draft. May throw; may be slow.
   *
   * The return type is `unknown` on purpose: an adapter cannot be trusted to
   * have produced the right shape, and typing it as `AiCompletion` here would
   * make the validation step look optional to the next person who writes an
   * adapter. It is not optional, and the type says so.
   */
  complete(request: AiCompletionRequest): Promise<AiCompletionDraft>;
}

/** Multi-provider token. Every registered adapter is collected into one array by the module. */
export const AI_PROVIDERS = Symbol('BEAUCLICK_AI_PROVIDERS');

/** The deterministic local provider's key. Named, never implicit (`F-03`). */
export const DETERMINISTIC_PROVIDER_KEY = 'deterministic';
