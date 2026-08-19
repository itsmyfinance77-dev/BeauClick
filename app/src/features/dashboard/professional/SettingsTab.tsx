import { DataExportCard } from '@/features/privacy/DataExportCard';
import { AccountDeletionCard } from '@/features/privacy/AccountDeletionCard';

/**
 * V2.4 Step 22. Mirrors the customer dashboard's AccountTab.tsx composition
 * for the parts that genuinely apply to a professional account too --
 * `DataExportCard`/`AccountDeletionCard` are already user-agnostic (real
 * `/privacy/*` endpoints, no customer-specific assumption anywhere in
 * either component). Notification preferences are deliberately NOT
 * duplicated here: this dashboard already has its own dedicated
 * "اعلان‌ها" tab (`NotificationsTab.tsx`), unlike the customer dashboard
 * which folds them into its single AccountTab.
 */
export function SettingsTab() {
	return (
		<div style={ { display: 'flex', flexDirection: 'column', gap: 20 } }>
			<h1 style={ { fontSize: 22, margin: 0 } }>تنظیمات</h1>
			<div className="bc-card" style={ { padding: 16 } }>
				<p style={ { margin: 0, fontSize: 14, color: 'var(--bc-color-ink-soft)' } }>
					ویرایش اطلاعات حساب و رمز عبور از طریق صفحه «حساب کاربری» ووکامرس در دسترس است.
				</p>
				<a href="/my-account/" className="bc-btn bc-btn--outline" style={ { marginTop: 12, display: 'inline-block' } }>
					رفتن به حساب کاربری
				</a>
			</div>

			<h2 style={ { fontSize: 17, margin: '8px 0 0' } }>حریم خصوصی و اطلاعات من</h2>
			<DataExportCard />
			<AccountDeletionCard />
		</div>
	);
}
