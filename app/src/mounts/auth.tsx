import { createRoot } from 'react-dom/client';
import { AuthFlow } from '@/features/auth/AuthFlow';
import '@/design-system/tokens.generated.css';

const el = document.getElementById( 'bc-auth-root' );
if ( el ) {
	createRoot( el ).render( <AuthFlow /> );
}
