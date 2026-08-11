export interface AiRecommendation {
	type: 'provider' | 'product' | 'service';
	id: number;
	eventId: number | null;
	name: string;
	url: string | null;
	priceFrom?: number | null;
	price?: number;
	rating?: number;
	reviewCount?: number;
	image?: string | null;
	durationMinutes?: number;
	providerId?: number | null;
	providerName?: string | null;
	reason?: string | null;
}

export interface AiMessage {
	id: number;
	conversationId: number;
	senderId: number | null;
	body: string;
	recommendations: AiRecommendation[];
	createdAt: string;
}
