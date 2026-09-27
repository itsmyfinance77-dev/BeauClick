/**
 * DEMO BRANCH ONLY — F-10 (demo/F10-DESIGN.md): the administrator's controlled
 * manual-refund execution routes (`bc_execute_manual_refunds`).
 */
import type { ApiClient } from './api-client';

export type ManualExecutionState = 'claimed' | 'executed' | 'uncertain' | 'released';

export interface ManualRefundRow {
  refundId: string;
  orderId: string;
  amountToman: number;
  status: 'pending' | 'succeeded' | 'failed' | 'manual_required' | 'superseded';
  manualTracked: boolean;
  reason: string;
  requestedAt: string;
  supersededAt: string | null;
  executions: Array<{
    executionId: string;
    state: ManualExecutionState;
    claimedAt: string;
    resolvedAt: string | null;
    externalReference: string | null;
    note: string | null;
  }>;
}

export const manualRefundApi = {
  list: (api: ApiClient) => api.get<ManualRefundRow[]>('/v1/admin/refunds/manual'),
  claim: (api: ApiClient, refundId: string, note?: string) =>
    api.post<{ executionId: string; state: ManualExecutionState }>(`/v1/admin/refunds/manual/${encodeURIComponent(refundId)}/claim`, note ? { note } : {}),
  resolve: (api: ApiClient, executionId: string, body: { outcome: 'executed' | 'uncertain' | 'released'; externalReference?: string; note?: string }) =>
    api.post<{ state: ManualExecutionState; refundStatus: string }>(`/v1/admin/refunds/manual/executions/${encodeURIComponent(executionId)}/resolve`, body),
};
