import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardLayout, type NavItem } from '@/features/dashboard/shared/DashboardLayout';
import { BookingsTab } from '@/features/dashboard/shared/BookingsTab';
import { OrdersTab } from '@/features/dashboard/customer/OrdersTab';
import { AccountTab } from '@/features/dashboard/customer/AccountTab';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { JourneyTab } from '@/features/journey/JourneyTab';
import { EmptyState } from '@/design-system';
import '@/design-system/tokens.generated.css';

// V2.0 Step 4: fills the "باشگاه مشتریان" slot this codebase reserved since
// V1 -- Beauty Journey subsumes it (loyalty balance is one of its own
// sections) rather than adding a second, competing nav destination.
const NAV_ITEMS: NavItem[] = [
	{ id: 'bookings', label: 'رزروهای من', ready: true },
	{ id: 'orders', label: 'سفارش‌ها', ready: true },
	{ id: 'wishlist', label: 'علاقه‌مندی‌ها', ready: false },
	{ id: 'messages', label: 'پیام‌ها', ready: true },
	{ id: 'journey', label: 'مسیر زیبایی من', ready: true },
	{ id: 'account', label: 'حساب کاربری', ready: true },
];

function App() {
	const [ tab, setTab ] = useState( 'bookings' );

	return (
		<DashboardLayout navItems={ NAV_ITEMS } activeTab={ tab } onTabChange={ setTab }>
			{ tab === 'bookings' && <BookingsTab /> }
			{ tab === 'orders' && <OrdersTab /> }
			{ tab === 'messages' && <ChatPanel /> }
			{ tab === 'journey' && <JourneyTab /> }
			{ tab === 'account' && <AccountTab /> }
			{ ! [ 'bookings', 'orders', 'messages', 'journey', 'account' ].includes( tab ) && (
				<EmptyState title="این بخش در نسخه بعدی محصول تکمیل می‌شود." />
			) }
		</DashboardLayout>
	);
}

const el = document.getElementById( 'bc-dashboard-customer-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
