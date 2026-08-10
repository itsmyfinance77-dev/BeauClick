import { mount } from '@/lib/mount';
import '@/design-system/tokens.generated.css';

// Full implementation lands in Phase 4 (marketplace) — city/specialty/price/
// rating filters hydrating over the server-rendered marketplace grid.
mount( 'bc-marketplace-filters-root', ( el ) => {
	el.textContent = '';
	return <></>;
} );
