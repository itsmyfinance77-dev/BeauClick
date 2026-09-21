/**
 * The only configuration the browser bundle needs. NEXT_PUBLIC_* values are
 * embedded in client JS and are therefore PUBLIC by definition -- never put
 * a secret here (JWT signing secrets, OTP HMAC secrets, and DATABASE_URL
 * live exclusively in the API's own server-side environment).
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3099/api';

/**
 * The public origin this site is served from -- the one thing metadata, the
 * sitemap and robots.txt need that a request-less server render cannot learn
 * for itself. `NEXT_PUBLIC_SITE_URL` in production; the local default is the
 * dev server's own origin so a fresh checkout emits working absolute URLs.
 *
 * A trailing slash is dropped so `${SITE_URL}${path}` never yields `//`.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3100').replace(/\/+$/, '');
