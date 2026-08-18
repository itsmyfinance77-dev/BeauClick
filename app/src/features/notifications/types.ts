export type NotificationCategory = 'reminder' | 'waitlist' | 'rebooking' | 'retention' | 'referral';

export type NotificationPreferences = Record<NotificationCategory, boolean>;

export interface NotificationRecord {
	id: number;
	category: string;
	templateKey: string;
	channel: 'sms' | 'email';
	status: string;
	createdAt: string;
	isRead: boolean;
}
