import type { AiRecommendation } from '@/features/ai/types';

export interface BeautyProfile {
	userId: number;
	preferredCityId: number | null;
	preferredSpecialtyIds: number[];
	budgetMin: number | null;
	budgetMax: number | null;
	notes: string | null;
}

export interface BeautyGoal {
	id: number;
	userId: number;
	title: string;
	specialtyId: number | null;
	cityId: number | null;
	budget: number | null;
	targetDate: string | null;
	status: 'active' | 'achieved' | 'abandoned';
	createdAt: string;
}

export interface JourneyBookingSummary {
	id: number;
	providerId: number;
	providerName: string;
	serviceId: number | null;
	serviceName: string | null;
	slotStart: string;
	status: string;
}

export interface JourneySummary {
	profile: BeautyProfile;
	activeGoals: BeautyGoal[];
	upcomingBookings: JourneyBookingSummary[];
	recentCompletedServices: JourneyBookingSummary[];
	loyaltyBalance: number | null;
	// Same shape AI's own RecommendationCard already renders -- reused directly, never redefined.
	recentRecommendations: AiRecommendation[];
	memberSince: string | null;
}

export interface TimelineEntry {
	type: string;
	label: string;
	entityType: string;
	entityId: number;
	meta: Record<string, unknown>;
	createdAt: string;
}
