import { NotificationPreferences } from '@/features/notifications/NotificationPreferences';
import { NotificationsList } from '@/features/notifications/NotificationsList';
import { DataExportCard } from '@/features/privacy/DataExportCard';
import { AccountDeletionCard } from '@/features/privacy/AccountDeletionCard';

export function AccountTab() {
	return (
		<div style={ { display: 'flex', flexDirection: 'column', gap: 20 } }>
			<h1 style={ { fontSize: 22, margin: 0 } }>حساب کاربری</h1>
			<div className="bc-card" style={ { padding: 16 } }>
				<p style={ { margin: 0, fontSize: 14, color: 'var(--bc-color-ink-soft)' } }>
					ویرایش اطلاعات حساب و آدرس‌ها از طریق صفحه «حساب کاربری» ووکامرس در دسترس است.
				</p>
				<a href="/my-account/" className="bc-btn bc-btn--outline" style={ { marginTop: 12, display: 'inline-block' } }>
					رفتن به حساب کاربری
				</a>
			</div>

			<NotificationPreferences />

			<div className="bc-card" style={ { padding: 16 } }>
				<h3 style={ { marginTop: 0, fontSize: 15 } }>اعلان‌های اخیر</h3>
				<NotificationsList />
			</div>

			<h2 style={ { fontSize: 17, margin: '8px 0 0' } }>حریم خصوصی و اطلاعات من</h2>
			<DataExportCard />
			<AccountDeletionCard />
		</div>
	);
}
