export function StatCard( { label, value }: { label: string; value: string } ) {
	return (
		<div className="bc-card" style={ { padding: 16 } }>
			<p style={ { margin: '0 0 6px', fontSize: 13, color: 'var(--bc-color-ink-faint)' } }>{ label }</p>
			<strong className="bc-numeric" style={ { fontSize: 22 } }>{ value }</strong>
		</div>
	);
}
