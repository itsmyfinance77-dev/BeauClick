import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardLayout, type NavItem } from '@/features/dashboard/shared/DashboardLayout';
import { BookingsTab } from '@/features/dashboard/shared/BookingsTab';
import { OrdersTab } from '@/features/dashboard/customer/OrdersTab';
import { AccountTab } from '@/features/dashboard/customer/AccountTab';
import { EmptyState } from '@/design-system';
import '@/design-system/tokens.generated.css';

const NAV_ITEMS: NavItem[] = [
	{ id: 'bookings', label: 'رزروهای من', ready: true },
	{ id: 'orders', label: 'سفارش‌ها', ready: true },
	{ id: 'wishlist', label: 'علاقه‌مندی‌ها', ready: false },
	{ id: 'messages', label: 'پیام‌ها', ready: false },
	{ id: 'loyalty', label: 'باشگاه مشتریان', ready: false },
	{ id: 'account', label: 'حساب کاربری', ready: true },
];

function App() {
	const [ tab, setTab ] = useState( 'bookings' );

	return (
		<DashboardLayout navItems={ NAV_ITEMS } activeTab={ tab } onTabChange={ setTab }>
			{ tab === 'bookings' && <BookingsTab /> }
			{ tab === 'orders' && <OrdersTab /> }
			{ tab === 'account' && <AccountTab /> }
			{ ! [ 'bookings', 'orders', 'account' ].includes( tab ) && (
				<EmptyState title="این بخش در نسخه بعدی محصول تکمیل می‌شود." />
			) }
		</DashboardLayout>
	);
}

const el = document.getElementById( 'bc-dashboard-customer-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
