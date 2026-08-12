export interface DashboardBooking {
	id: number;
	customerName: string;
	slotStart: string;
	status: string;
}

export interface DashboardStats {
	todaysBookings: number;
	monthRevenue: number;
	newClients: number;
	rating: number;
	reviewCount: number;
	weeklyBookings: { date: string; count: number }[];
	todayUpcoming: DashboardBooking[];
	recentBookings: DashboardBooking[];
}

export interface MyService {
	id: number;
	name: string;
	status: string;
	durationMinutes: number;
	price: number;
}

export interface VerificationRequestSummary {
	id: number;
	status: string;
	submittedAt: string;
	decidedAt: string | null;
	decisionReason: string | null;
}

export interface VerificationEvidenceItem {
	id: number;
	evidenceType: string;
	originalFilename: string;
	mimeType: string;
	sizeBytes: number;
	uploadedAt: string;
}

export interface VerificationHistoryItem {
	fromStatus: string;
	toStatus: string;
	reason: string | null;
	createdAt: string;
}

export interface VerificationSummary {
	status: string;
	canSubmit: boolean;
	latestRequest: VerificationRequestSummary | null;
	evidence: VerificationEvidenceItem[];
	history: VerificationHistoryItem[];
}
