import {
  isAiRefusalReason,
  type AiConversationSummary,
  type AiMessageView,
  type AiQuotaView,
  type AiRefusalReason,
} from '@beauclick/ai-contract';
import { ApiRequestError, type ApiClient } from './api-client';

/**
 * The customer AI assistant's routes — `35_AI_ASSISTANT.md`, `/v1/me/ai/*`.
 *
 * Every route is self-scoped: none takes an owner, customer or user id, and
 * nothing here adds one. Shapes come from `@beauclick/ai-contract`, the one
 * definition the server and this page share.
 */

export interface AiConsentView {
  accepted: boolean;
  contractKey: string | null;
  acceptedAt: string | null;
}

export interface AiConversationPage {
  items: AiConversationSummary[];
  nextCursor: string | null;
}

export interface AiConversationDetail {
  conversation: AiConversationSummary;
  messages: AiMessageView[];
}

export interface AiExchange {
  conversation: AiConversationSummary;
  /** The customer's message and the assistant's reply, in that order. */
  messages: AiMessageView[];
  quota: AiQuotaView;
}

export const aiApi = {
  consent: (api: ApiClient) => api.get<AiConsentView>('/v1/me/ai/consent'),
  /** The route declares no body; the client's empty object carries nothing. */
  acceptConsent: (api: ApiClient) => api.post<AiConsentView>('/v1/me/ai/consent'),
  conversations: (api: ApiClient, cursor?: string | null) =>
    api.get<AiConversationPage>(`/v1/me/ai/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  start: (api: ApiClient) => api.post<AiConversationSummary>('/v1/me/ai/conversations'),
  conversation: (api: ApiClient, id: string) => api.get<AiConversationDetail>(`/v1/me/ai/conversations/${encodeURIComponent(id)}`),
  send: (api: ApiClient, id: string, body: string) =>
    api.post<AiExchange>(`/v1/me/ai/conversations/${encodeURIComponent(id)}/messages`, { body }),
  destroy: (api: ApiClient, id: string) => api.delete<null>(`/v1/me/ai/conversations/${encodeURIComponent(id)}`),
  recordClick: (api: ApiClient, recommendationId: string) =>
    api.post<null>(`/v1/me/ai/recommendations/${encodeURIComponent(recommendationId)}/click`),
};

/**
 * A refusal the assistant's contract names, as far as the page may act on it.
 *
 * `message` is the server's own Persian sentence, rendered verbatim — the
 * contract makes the server the author of refusal copy. `resetsAt` is present
 * only on `quota_exhausted`, as the absolute Tehran-boundary instant the server
 * computed; the page never derives one.
 */
export interface AiRefusal {
  reason: AiRefusalReason;
  message: string;
  resetsAt: string | null;
}

/** Reads `details.reason` from an `AI_REFUSED` envelope. Anything else is not a refusal. */
export function aiRefusalOf(error: unknown): AiRefusal | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'AI_REFUSED') return null;
  const details = (error.details ?? {}) as { reason?: unknown; resetsAt?: unknown };
  if (!isAiRefusalReason(details.reason)) return null;
  return {
    reason: details.reason,
    message: error.message,
    resetsAt: typeof details.resetsAt === 'string' ? details.resetsAt : null,
  };
}

/**
 * The one "not here any more" answer.
 *
 * A deleted conversation, another customer's, and one the 30-day sweep removed
 * are the SAME 404 on the server, deliberately; the page says one sentence for
 * all three and offers no restore.
 */
export function isConversationGone(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

/**
 * The capability was withdrawn after the page loaded: a plain 403 that is not
 * an assistant refusal (`consent_required` is a 403 too, and IS one).
 */
export function isAccessWithdrawn(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403 && aiRefusalOf(error) === null;
}
