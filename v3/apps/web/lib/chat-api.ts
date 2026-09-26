import {
  isChatRefusalReason,
  type ChatConversationSummary,
  type ChatCounterpartyType,
  type ChatEligibleCounterpartyView,
  type ChatMessageView,
  type ChatRefusalReason,
  type ChatReportReason,
  type ChatReportView,
  type ChatSide,
  type ChatUnreadCountView,
} from '@beauclick/chat-contract';
import { ApiRequestError, type ApiClient } from './api-client';

/**
 * The participant chat routes — `36_INTERNAL_CHAT.md`, `/v1/chat/*`.
 *
 * No route takes a customer, sender or user id, and nothing here adds one. A
 * counterparty pair is only ever sent back exactly as the server handed it out
 * (`eligible-counterparties`), never composed from a booking's fields.
 */

export interface ChatConversationPage {
  items: ChatConversationSummary[];
  nextCursor: string | null;
}

export interface ChatMessagePage {
  /** Newest first, as the server pages them. */
  items: ChatMessageView[];
  nextBeforeSequence: number | null;
}

export interface ChatSendResult {
  message: ChatMessageView;
  conversation: ChatConversationSummary;
}

export interface ChatInboxFilter {
  side?: ChatSide;
  counterpartyType?: ChatCounterpartyType;
}

function inboxQuery(filter: ChatInboxFilter, cursor: string | null | undefined): string {
  const params = new URLSearchParams();
  if (filter.side) params.set('side', filter.side);
  if (filter.counterpartyType) params.set('counterpartyType', filter.counterpartyType);
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

const id = (value: string) => encodeURIComponent(value);

export const chatApi = {
  conversations: (api: ApiClient, filter: ChatInboxFilter = {}, cursor?: string | null) =>
    api.get<ChatConversationPage>(`/v1/chat/conversations${inboxQuery(filter, cursor)}`),
  conversation: (api: ApiClient, conversationId: string) =>
    api.get<ChatConversationSummary>(`/v1/chat/conversations/${id(conversationId)}`),
  messages: (api: ApiClient, conversationId: string, before?: number | null) =>
    api.get<ChatMessagePage>(
      `/v1/chat/conversations/${id(conversationId)}/messages${before ? `?before=${encodeURIComponent(String(before))}` : ''}`,
    ),
  /** `idempotencyKey` is reused by a retry of the SAME message, so a retried POST returns the original. */
  send: (api: ApiClient, conversationId: string, body: string, idempotencyKey: string) =>
    api.post<ChatSendResult>(`/v1/chat/conversations/${id(conversationId)}/messages`, { body, idempotencyKey }),
  markRead: (api: ApiClient, conversationId: string, upToSequence: number) =>
    api.post<{ lastReadSequence: number; unread: ChatUnreadCountView }>(`/v1/chat/conversations/${id(conversationId)}/read`, {
      upToSequence,
    }),
  unreadCount: (api: ApiClient) => api.get<ChatUnreadCountView>('/v1/chat/unread-count'),
  eligibleCounterparties: (api: ApiClient) =>
    api.get<{ items: ChatEligibleCounterpartyView[] }>('/v1/chat/eligible-counterparties'),
  start: (api: ApiClient, counterpartyType: ChatCounterpartyType, counterpartyId: string) =>
    api.post<ChatConversationSummary>('/v1/chat/conversations', { counterpartyType, counterpartyId }),
  block: (api: ApiClient, conversationId: string) => api.post<null>(`/v1/chat/conversations/${id(conversationId)}/block`),
  unblock: (api: ApiClient, conversationId: string) => api.delete<null>(`/v1/chat/conversations/${id(conversationId)}/block`),
  report: (api: ApiClient, conversationId: string, messageId: string, reason: ChatReportReason, note: string | null) =>
    api.post<ChatReportView>(`/v1/chat/conversations/${id(conversationId)}/report`, {
      messageId,
      reason,
      ...(note ? { note } : {}),
    }),
};

/** A refusal the chat contract names, with the server's own Persian sentence. */
export interface ChatRefusal {
  reason: ChatRefusalReason;
  message: string;
}

/** Reads `details.reason` from a `CHAT_REFUSED` envelope. Anything else is not a refusal. */
export function chatRefusalOf(error: unknown): ChatRefusal | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'CHAT_REFUSED') return null;
  const reason = (error.details as { reason?: unknown } | undefined)?.reason;
  if (!isChatRefusalReason(reason)) return null;
  return { reason, message: error.message };
}

/**
 * The one "not here any more" answer. A conversation that does not exist, one
 * belonging to somebody else, and one the caller has lost access to (a manager
 * deactivated, a grant withdrawn) are the same 404 on the server, on purpose.
 */
export function isChatGone(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

/** `bc_use_chat` withdrawn after load: a plain 403 that is not a chat refusal. */
export function isChatAccessWithdrawn(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403 && chatRefusalOf(error) === null;
}
