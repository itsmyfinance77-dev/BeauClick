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
import { ChatPanel } from '@/features/chat/ChatPanel';
import { EmptyState } from '@/design-system';
import '@/design-system/tokens.generated.css';

/**
 * V2.2 Step 16 — Calendar (a real self-service availability manager; before
 * this, no code path let a professional create a bookable slot at all) and
 * Analytics/Staff (new, reusing Step 11's MetricsService and this step's own
 * minimal staff model) join the previously-shipped Overview/Bookings/
 * Services/Reviews/Messages/Customers as real, data-backed tabs. Revenue
 * stays a documented placeholder — it depends on the future Financial/Payout
 * system (V2.3), not something this step can honestly build ahead of it.
 * Profile/Settings remain placeholders too — this step's own scope was
 * analytics/availability/staff/CRM, not the profile-editing UI gap (which
 * has no dedicated task ask here and is left for a future pass).
 */
const NAV_ITEMS: NavItem[] = [
	{ id: 'overview', label: 'نمای کلی', ready: true },
	{ id: 'bookings', label: 'رزروها', ready: true },
	{ id: 'calendar', label: 'تقویم', ready: true },
	{ id: 'services', label: 'خدمات', ready: true },
	{ id: 'customers', label: 'مشتریان', ready: true },
	{ id: 'analytics', label: 'آمار و تحلیل', ready: true },
	{ id: 'staff', label: 'کارکنان', ready: true },
	{ id: 'revenue', label: 'درآمد', ready: false },
	{ id: 'reviews', label: 'نظرات', ready: true },
	{ id: 'messages', label: 'پیام‌ها', ready: true },
	{ id: 'profile', label: 'پروفایل', ready: false },
	{ id: 'settings', label: 'تنظیمات', ready: false },
];

const READY_TABS = [ 'overview', 'bookings', 'calendar', 'services', 'customers', 'analytics', 'staff', 'reviews', 'messages' ];

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
			{ tab === 'reviews' && <ReviewsTab /> }
			{ tab === 'messages' && <ChatPanel /> }
			{ ! READY_TABS.includes( tab ) && <EmptyState title="این بخش در نسخه بعدی محصول تکمیل می‌شود." /> }
		</DashboardLayout>
	);
}

const el = document.getElementById( 'bc-dashboard-professional-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
