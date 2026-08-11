import { type ReactNode } from 'react';

export interface NavItem {
	id: string;
	label: string;
	ready: boolean;
}

export interface DashboardLayoutProps {
	navItems: NavItem[];
	activeTab: string;
	onTabChange: ( id: string ) => void;
	children: ReactNode;
}

/**
 * Left sidebar nav (horizontal scroll strip on mobile) + main content, per
 * design handoff §7. A full client-rendered app rather than SSR+islands
 * like Home/Marketplace — dashboards are login-gated with no SEO value, so
 * there's nothing SSR would buy here (architecture doc §18).
 */
export function DashboardLayout( { navItems, activeTab, onTabChange, children }: DashboardLayoutProps ) {
	return (
		<div style={ { display: 'flex', gap: 24, alignItems: 'flex-start' } } className="bc-dashboard-layout">
			<nav style={ { display: 'flex', gap: 4 } } className="bc-dashboard-nav">
				{ navItems.map( ( item ) => (
					<button
						key={ item.id }
						type="button"
						onClick={ () => onTabChange( item.id ) }
						style={ {
							textAlign: 'start',
							padding: '10px 14px',
							borderRadius: 12,
							border: 'none',
							background: activeTab === item.id ? 'var(--bc-color-primary-soft)' : 'transparent',
							color: activeTab === item.id ? 'var(--bc-color-primary)' : 'var(--bc-color-ink-soft)',
							fontWeight: activeTab === item.id ? 700 : 500,
							cursor: 'pointer',
							fontSize: 14,
							opacity: item.ready ? 1 : 0.7,
						} }
					>
						{ item.label }
					</button>
				) ) }
			</nav>
			<div style={ { flex: 1, minWidth: 0 } }>{ children }</div>
		</div>
	);
}
