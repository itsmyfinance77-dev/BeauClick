export type ExportStatus = 'pending' | 'ready' | 'expired' | 'failed';

export interface ExportRequest {
	id: number;
	status: ExportStatus;
	requestedAt: string;
	expiresAt: string | null;
	/** A relative REST path, not a ready-to-click URL — build the real href with api.urlWithNonce(). */
	downloadPath: string | null;
}

export type DeletionStatus = 'pending' | 'approved' | 'processing' | 'completed' | 'rejected' | 'blocked' | 'cancelled';

export interface DeletionRequest {
	id: number;
	status: DeletionStatus;
	reason: string | null;
	requestedAt: string;
	reviewedAt: string | null;
	completedAt: string | null;
}

export interface DeletionRequestResult {
	requestId: number;
	status: DeletionStatus;
	reasons?: string[];
}
