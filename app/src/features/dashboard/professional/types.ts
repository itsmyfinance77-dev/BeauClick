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
