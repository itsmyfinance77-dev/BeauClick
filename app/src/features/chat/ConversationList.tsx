import { formatShortDate, formatTime, toPersianDigits } from '@/lib/format';
import { EmptyState, LoadingDots } from '@/design-system';
import type { ConversationSummary } from './types';

export function ConversationList( {
	conversations,
	activeId,
	onSelect,
}: {
	conversations: ConversationSummary[] | null;
	activeId: number | null;
	onSelect: ( id: number ) => void;
} ) {
	if ( ! conversations ) return <LoadingDots />;
	if ( conversations.length === 0 ) return <EmptyState title="هنوز گفتگویی شروع نشده است." />;

	return (
		<div className="bc-chat-list">
			{ conversations.map( ( c ) => {
				const date = c.lastMessageAt ? new Date( c.lastMessageAt.replace( ' ', 'T' ) ) : null;
				return (
					<button
						key={ c.id }
						type="button"
						className={ `bc-chat-list__item${ activeId === c.id ? ' bc-chat-list__item--active' : '' }` }
						onClick={ () => onSelect( c.id ) }
					>
						<div style={ { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: '50%', background: 'var(--bc-gradient-brand)', color: 'white', fontWeight: 700, flexShrink: 0 } }>
							{ c.otherUserName ? c.otherUserName.charAt( 0 ) : '?' }
						</div>
						<div style={ { flex: 1, minWidth: 0, textAlign: 'start' } }>
							<div style={ { display: 'flex', justifyContent: 'space-between', gap: 8 } }>
								<strong style={ { fontSize: 14 } }>{ c.otherUserName || 'کاربر' }</strong>
								{ date && <span className="bc-numeric" style={ { fontSize: 11, color: 'var(--bc-color-ink-faint)', flexShrink: 0 } }>{ formatShortDate( date ).weekday }، { formatTime( date ) }</span> }
							</div>
							<p style={ { margin: '2px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }>{ c.lastMessage || '—' }</p>
						</div>
						{ c.unreadCount > 0 && (
							<span className="bc-numeric" style={ { background: 'var(--bc-color-primary)', color: 'white', borderRadius: 999, minWidth: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, padding: '0 6px', flexShrink: 0 } }>
								{ toPersianDigits( c.unreadCount ) }
							</span>
						) }
					</button>
				);
			} ) }
		</div>
	);
}
