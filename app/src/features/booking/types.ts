export interface ProviderService {
	id: number;
	name: string;
	durationMinutes: number;
	price: number;
}

export interface ProviderDetail {
	id: number;
	name: string;
	services: ProviderService[];
}

export interface AvailabilitySlot {
	id: number;
	serviceId: number | null;
	startAt: string;
	endAt: string;
}
