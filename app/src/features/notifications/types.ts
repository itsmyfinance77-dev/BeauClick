export type NotificationCategory = 'reminder' | 'waitlist' | 'rebooking' | 'retention' | 'referral';

export type NotificationPreferences = Record<NotificationCategory, boolean>;

export interface NotificationRecord {
	category: string;
	templateKey: string;
	channel: 'sms' | 'email';
	status: string;
	createdAt: string;
}
