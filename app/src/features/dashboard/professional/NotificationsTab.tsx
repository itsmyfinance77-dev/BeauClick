import { NotificationPreferences } from '@/features/notifications/NotificationPreferences';
import { NotificationsList } from '@/features/notifications/NotificationsList';

/**
 * V2.3 Step 20 (NOTIF-07): the customer-facing AccountTab.tsx has offered
 * notification preferences since V2.1 Step 10 -- the backend
 * (PreferenceService/NotificationsController) is already fully generic,
 * keyed on the session's own user_id with no customer-specific concept
 * anywhere in it, so a professional/business account (a real WP user with
 * a real session, per RoleManager) already works against the exact same
 * `/notifications/preferences` and `/notifications/mine` routes with zero
 * backend change. This tab mirrors AccountTab.tsx's own composition
 * exactly -- the same two components, not a reimplementation -- so the two
 * surfaces can never silently drift on what a preference toggle does.
 *
 * Deliberately excludes AccountTab.tsx's WooCommerce-account link and
 * privacy (data export/deletion) cards -- those are customer-account
 * concepts unrelated to this step's scope (notification preferences only).
 */
export function NotificationsTab() {
	return (
		<div style={ { display: 'flex', flexDirection: 'column', gap: 20 } }>
			<h1 style={ { fontSize: 22, margin: 0 } }>اعلان‌ها</h1>

			<NotificationPreferences />

			<div className="bc-card" style={ { padding: 16 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>اعلان‌های اخیر</h3>
				<NotificationsList />
			</div>
		</div>
	);
}
