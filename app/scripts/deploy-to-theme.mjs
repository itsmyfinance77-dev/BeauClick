#!/usr/bin/env node
/**
 * Copies the Vite build output (app/dist/) into the WordPress theme
 * (wordpress/wp-content/themes/beauclick/app-dist/) so the theme is
 * self-contained and deployable as-is — no web server needs to serve
 * anything from outside wordpress/. Wired as `postbuild` (npm run build
 * already ran `npm run tokens` via `prebuild`; this is the equivalent
 * last step, not something a developer runs by hand).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const src = path.resolve( __dirname, '../dist' );
const dest = path.resolve( __dirname, '../../wordpress/wp-content/themes/beauclick/app-dist' );

if ( ! existsSync( src ) ) {
	console.error( '[deploy-to-theme] app/dist does not exist — run `npm run build` first.' );
	process.exit( 1 );
}

if ( existsSync( dest ) ) {
	rmSync( dest, { recursive: true, force: true } );
}

cpSync( src, dest, { recursive: true } );
console.log( `[deploy-to-theme] copied app/dist -> ${ path.relative( process.cwd(), dest ) }` );
