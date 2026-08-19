import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardLayout, type NavItem } from '@/features/dashboard/shared/DashboardLayout';
import { OverviewTab } from '@/features/dashboard/professional/OverviewTab';
import { BookingsTab } from '@/features/dashboard/shared/BookingsTab';
import { ServicesTab } from '@/features/dashboard/professional/ServicesTab';
import { ReviewsTab } from '@/features/dashboard/professional/ReviewsTab';
import { CustomersTab } from '@/features/dashboard/professional/CustomersTab';
import { CalendarTab } from '@/features/dashboard/professional/CalendarTab';
import { AnalyticsTab } from '@/features/dashboard/professional/AnalyticsTab';
import { StaffTab } from '@/features/dashboard/professional/StaffTab';
import { RevenueTab } from '@/features/dashboard/professional/RevenueTab';
import { ProfessionalAiTab } from '@/features/dashboard/professional/ProfessionalAiTab';
import { NotificationsTab } from '@/features/dashboard/professional/NotificationsTab';
import { ProfileTab } from '@/features/dashboard/professional/ProfileTab';
import { SettingsTab } from '@/features/dashboard/professional/SettingsTab';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { EmptyState } from '@/design-system';
import '@/design-system/tokens.generated.css';

/**
 * V2.2 Step 16 — Calendar (a real self-service availability manager; before
 * this, no code path let a professional create a bookable slot at all) and
 * Analytics/Staff (new, reusing Step 11's MetricsService and this step's own
 * minimal staff model) join the previously-shipped Overview/Bookings/
 * Services/Reviews/Messages/Customers as real, data-backed tabs.
 *
 * V2.3 Step 18 — Revenue is now real too: the single most-anticipated
 * "coming later" promise this dashboard has carried since V1 (see this
 * docblock's own prior history), now backed by a real, ownership-scoped,
 * WooCommerce-order-derived financial ledger (`beauclick-financial`) rather
 * than an invented figure.
 *
 * V2.3 Step 19 — a read-only AI insight tab, reading the professional's own
 * already-ownership-scoped booking/review/financial/campaign data (never a
 * second calculation engine — see ProfessionalContext's own docblock).
 * Placed right after Revenue: the two most natural "ask a follow-up
 * question about what I just saw" tabs sit next to each other.
 *
 * V2.3 Step 20 (NOTIF-07) — Notifications is new: a real dashboard surface
 * for the already-generic PreferenceService/NotificationsController,
 * mirroring the customer AccountTab.tsx's own composition (see
 * NotificationsTab.tsx's own docblock). Placed after Messages, before
 * Profile/Settings.
 *
 * V2.4 Step 22 — Profile and Settings are real now: Profile edits
 * name/bio/specialties (the backend already existed via MyProfileController;
 * only the UI was missing) plus real portfolio image management, the
 * public profile page's own long-standing "این بخش در نسخه بعدی محصول
 * تکمیل می‌شود" placeholder finally closed. Settings mirrors the customer
 * AccountTab's privacy cards (already user-agnostic) — notification
 * preferences are NOT duplicated here since this dashboard already has its
 * own dedicated Notifications tab, unlike the customer dashboard.
 */
const NAV_ITEMS: NavItem[] = [
	{ id: 'overview', label: 'نمای کلی', ready: true },
	{ id: 'bookings', label: 'رزروها', ready: true },
	{ id: 'calendar', label: 'تقویم', ready: true },
	{ id: 'services', label: 'خدمات', ready: true },
	{ id: 'customers', label: 'مشتریان', ready: true },
	{ id: 'analytics', label: 'آمار و تحلیل', ready: true },
	{ id: 'staff', label: 'کارکنان', ready: true },
	{ id: 'revenue', label: 'درآمد', ready: true },
	{ id: 'ai', label: 'دستیار هوشمند', ready: true },
	{ id: 'reviews', label: 'نظرات', ready: true },
	{ id: 'messages', label: 'پیام‌ها', ready: true },
	{ id: 'notifications', label: 'اعلان‌ها', ready: true },
	{ id: 'profile', label: 'پروفایل', ready: true },
	{ id: 'settings', label: 'تنظیمات', ready: true },
];

const READY_TABS = [ 'overview', 'bookings', 'calendar', 'services', 'customers', 'analytics', 'staff', 'revenue', 'ai', 'reviews', 'messages', 'notifications', 'profile', 'settings' ];

function App() {
	const [ tab, setTab ] = useState( 'overview' );

	return (
		<DashboardLayout navItems={ NAV_ITEMS } activeTab={ tab } onTabChange={ setTab }>
			{ tab === 'overview' && <OverviewTab /> }
			{ tab === 'bookings' && <BookingsTab /> }
			{ tab === 'calendar' && <CalendarTab /> }
			{ tab === 'services' && <ServicesTab /> }
			{ tab === 'customers' && <CustomersTab /> }
			{ tab === 'analytics' && <AnalyticsTab /> }
			{ tab === 'staff' && <StaffTab /> }
			{ tab === 'revenue' && <RevenueTab /> }
			{ tab === 'ai' && <ProfessionalAiTab /> }
			{ tab === 'reviews' && <ReviewsTab /> }
			{ tab === 'messages' && <ChatPanel /> }
			{ tab === 'notifications' && <NotificationsTab /> }
			{ tab === 'profile' && <ProfileTab /> }
			{ tab === 'settings' && <SettingsTab /> }
			{ ! READY_TABS.includes( tab ) && <EmptyState title="این بخش در نسخه بعدی محصول تکمیل می‌شود." /> }
		</DashboardLayout>
	);
}

const el = document.getElementById( 'bc-dashboard-professional-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
