import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@/design-system/tokens.generated.css';
import '@/design-system/base.css';

const rootEl = document.getElementById( 'root' );
if ( rootEl ) {
	createRoot( rootEl ).render(
		<StrictMode>
			<App />
		</StrictMode>
	);
}
