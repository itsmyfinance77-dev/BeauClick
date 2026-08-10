import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Multiple named entry points so the WordPress theme can enqueue only the
// bundle a given page actually needs (marketplace filters vs. the full
// dashboard shell vs. the AI panel) — see architecture doc §21 on
// per-surface code splitting. `main` is the local dev-only preview harness
// and is never enqueued by the theme.
export default defineConfig( {
	plugins: [ react() ],
	resolve: {
		alias: {
			'@': path.resolve( __dirname, 'src' ),
		},
	},
	build: {
		outDir: 'dist',
		manifest: true,
		rollupOptions: {
			input: {
				main: path.resolve( __dirname, 'index.html' ),
				'marketplace-filters': path.resolve( __dirname, 'src/mounts/marketplace-filters.tsx' ),
				booking: path.resolve( __dirname, 'src/mounts/booking.tsx' ),
				cart: path.resolve( __dirname, 'src/mounts/cart.tsx' ),
				'ai-assistant': path.resolve( __dirname, 'src/mounts/ai-assistant.tsx' ),
				chat: path.resolve( __dirname, 'src/mounts/chat.tsx' ),
				'dashboard-professional': path.resolve( __dirname, 'src/mounts/dashboard-professional.tsx' ),
				'dashboard-customer': path.resolve( __dirname, 'src/mounts/dashboard-customer.tsx' ),
			},
		},
	},
	server: {
		port: 5173,
	},
} );
