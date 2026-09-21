import type { ApiClient } from './api-client';

/**
 * The customer's own privacy surface: `GET/POST /v1/privacy/*`.
 *
 * There is no user id anywhere in these routes — the server takes the subject
 * from the session — so "export or delete somebody else's data" is a request
 * this client cannot express either.
 */

export type PrivacyRequestKind = 'export' | 'erasure';

/** Every status either kind can be in. `ready` is export-only and `completed` is erasure-only. */
export type PrivacyRequestStatus = 'pending' | 'processing' | 'ready' | 'completed' | 'cancelled' | 'expired' | 'failed';

export interface PrivacyRequest {
  id: string;
  kind: PrivacyRequestKind;
  status: PrivacyRequestStatus;
  requestedAt: string;
  /** Erasure only: when the grace window closes. */
  executeAfter: string | null;
  /** Export only: when the document stops being downloadable. Null until it is generated. */
  expiresAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  failureCode: string | null;
}

/** `moduleKey.sectionKey` → the section's Persian description and its rows. */
export interface ExportSection {
  description: string;
  rows: ReadonlyArray<Record<string, unknown>>;
}

/** What the platform deliberately keeps, and the server's stated reason. */
export interface RetainedEntry {
  module: string;
  table: string;
  reason: string;
}

export interface ExportDocument {
  documentVersion: number;
  subjectUserId: string;
  generatedAt: string;
  sections: Record<string, ExportSection>;
  retained: RetainedEntry[];
}

export interface ExportDownload {
  byteSize: number;
  checksumSha256: string;
  expiresAt: string;
  document: ExportDocument;
}

/** Everything the caller has asked for, both kinds, newest first. */
export function privacyRequests(api: ApiClient) {
  return api.get<PrivacyRequest[]>('/v1/privacy/requests');
}

export function requestExport(api: ApiClient) {
  return api.post<PrivacyRequest>('/v1/privacy/export');
}

/** The document itself: only the subject, with a live session, before it expires. No signed URL exists. */
export function downloadExport(api: ApiClient, requestId: string) {
  return api.get<ExportDownload>(`/v1/privacy/export/${encodeURIComponent(requestId)}/download`);
}

/** The typed confirmation is exactly `DELETE` and the server refuses anything else. */
export const ERASURE_CONFIRMATION = 'DELETE';

export function requestErasure(api: ApiClient) {
  return api.post<PrivacyRequest>('/v1/privacy/deletion', { confirm: ERASURE_CONFIRMATION });
}

export function cancelErasure(api: ApiClient, requestId: string) {
  return api.post<PrivacyRequest>(`/v1/privacy/deletion/${encodeURIComponent(requestId)}/cancel`);
}

/** The most recent request of a kind — the list is newest first, but a sort makes that not a matter of trust. */
export function latestOfKind(requests: readonly PrivacyRequest[], kind: PrivacyRequestKind): PrivacyRequest | null {
  return (
    requests
      .filter((r) => r.kind === kind)
      .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())[0] ?? null
  );
}

/** Open means the server's own partial-unique rule: one per subject per kind, `pending` or `processing`. */
export function isOpen(request: PrivacyRequest | null): boolean {
  return request?.status === 'pending' || request?.status === 'processing';
}
