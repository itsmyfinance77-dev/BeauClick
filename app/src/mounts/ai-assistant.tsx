import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiPanel } from '@/features/ai/AiPanel';
import '@/design-system/tokens.generated.css';

/**
 * Unlike booking/cart/chat, the AI launch point has no page-specific
 * trigger to delegate from — it's a floating button present on every
 * screen (design handoff §9), so this mount renders both the FAB and the
 * panel itself rather than listening for a `[data-bc-*]` click elsewhere.
 */
function App() {
	const [ open, setOpen ] = useState( false );

	return (
		<>
			<button
				type="button"
				className="bc-ai-fab"
				onClick={ () => setOpen( true ) }
				aria-label="دستیار هوشمند زیبایی"
			>
				AI
			</button>
			<AiPanel open={ open } onClose={ () => setOpen( false ) } />
		</>
	);
}

const el = document.getElementById( 'bc-ai-assistant-root' );
if ( el ) {
	createRoot( el ).render( <App /> );
}
