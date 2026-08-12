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

export interface LoyaltyTier {
	id: number;
	slug: string;
	name: string;
	thresholdPoints: number;
	isActive: boolean;
}

export interface LoyaltyBenefit {
	id: number;
	sourceType: 'tier' | 'membership_plan';
	sourceId: number;
	benefitType: 'bonus_points_multiplier' | 'discount_percentage' | 'descriptive';
	label: string;
	config: Record<string, unknown>;
	isActive: boolean;
}

export interface MembershipPlan {
	id: number;
	slug: string;
	name: string;
	tierId: number | null;
	isPaid: boolean;
	price: number | null;
	billingPeriodDays: number | null;
	isActive: boolean;
}

export interface Membership {
	id: number;
	planId: number;
	plan: MembershipPlan | null;
	status: 'active' | 'expired' | 'cancelled';
	activationSource: string;
	startedAt: string;
	expiresAt: string | null;
}

export interface TierProgress {
	lifetimePoints: number;
	currentTier: LoyaltyTier | null;
	nextTier: LoyaltyTier | null;
	pointsToNext: number | null;
	percentToNext: number | null;
}

export interface LoyaltyHistoryEntry {
	points: number;
	reason: string;
	createdAt: string;
}

export interface LoyaltySummary {
	balance: number;
	lifetimeEarned: number;
	progress: TierProgress;
	membership: Membership | null;
	benefits: LoyaltyBenefit[];
	history: LoyaltyHistoryEntry[];
}
