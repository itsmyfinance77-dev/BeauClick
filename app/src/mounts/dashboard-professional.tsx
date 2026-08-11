import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardLayout, type NavItem } from '@/features/dashboard/shared/DashboardLayout';
import { OverviewTab } from '@/features/dashboard/professional/OverviewTab';
import { BookingsTab } from '@/features/dashboard/shared/BookingsTab';
import { ServicesTab } from '@/features/dashboard/professional/ServicesTab';
import { EmptyState } from '@/design-system';
import '@/design-system/tokens.generated.css';

/**
 * Overview/Bookings/Services are real and data-backed. The remaining seven
 * items keep the design handoff's approved 10-item nav intact but render
 * its own documented placeholder copy — Calendar/Reviews need Phase 11,
 * Messages needs Phase 9 (chat), the rest are deeper cuts of data this
 * dashboard already fetches rather than new capability.
 */
const NAV_ITEMS: NavItem[] = [
	{ id: 'overview', label: 'نمای کلی', ready: true },
	{ id: 'bookings', label: 'رزروها', ready: true },
	{ id: 'calendar', label: 'تقویم', ready: false },
	{ id: 'services', label: 'خدمات', ready: true },
	{ id: 'customers', label: 'مشتریان', ready: false },
	{ id: 'revenue', label: 'درآمد', ready: false },
	{ id: 'reviews', label: 'نظرات', ready: false },
	{ id: 'messages', label: 'پیام‌ها', ready: false },
	{ id: 'profile', label: 'پروفایل', ready: false },
	{ id: 'settings', label: 'تنظیمات', ready: false },
];

function App() {
	const [ tab, setTab ] = useState( 'overview' );

	return (
		<DashboardLayout navItems={ NAV_ITEMS } activeTab={ tab } onTabChange={ setTab }>
			{ tab === 'overview' && <OverviewTab /> }
			{ tab === 'bookings' && <BookingsTab /> }
			{ tab === 'services' && <ServicesTab /> }
			{ ! [ 'overview', 'bookings', 'services' ].includes( tab ) && (
				<EmptyState title="این بخش در نسخه بعدی محصول تکمیل می‌شود." />
			) }
		</DashboardLayout>
	);
}

const el = document.getElementById( 'bc-dashboard-professional-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
