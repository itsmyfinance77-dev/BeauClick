/**
 * Thin wrapper around the beauclick/v1 REST API. Auth is cookie + REST
 * nonce (architecture doc §19) — same-origin, no token storage — so every
 * mutating request needs the nonce WordPress localizes onto
 * `window.BeauClick` (see functions.php's inline bootstrap script).
 */

declare global {
	interface Window {
		BeauClick?: {
			restUrl: string;
			nonce: string;
			isLoggedIn: boolean;
			currentUserId: number;
			checkoutUrl: string | null;
			cartUrl: string | null;
		};
	}
}

export interface ApiEnvelope<T> {
	data: T;
	meta: { pagination?: { total: number; page: number; per_page: number; pages: number } };
	error: { code: string; message: string; details?: unknown } | null;
}

export class ApiError extends Error {
	constructor( public code: string, message: string, public status: number ) {
		super( message );
	}
}

function baseUrl(): string {
	return window.BeauClick?.restUrl ?? '/wp-json/beauclick/v1';
}

/**
 * Naive `${baseUrl()}${path}` string concatenation breaks under WordPress's
 * plain-permalink structure: there, rest_url() returns
 * `/?rest_route=/beauclick/v1` (a query string, not a clean path), so
 * appending a path that has its OWN `?provider_id=...` produces a second
 * literal `?` that becomes part of the rest_route value instead of
 * starting real query params — the request silently 404s. Building the
 * URL properly (merging into rest_route when present, or appending to the
 * pathname otherwise) works under both plain and pretty permalinks.
 * Caught by live testing against this dev environment's plain permalinks,
 * not by anything that would have shown up in isolated component code.
 */
function buildUrl( path: string ): string {
	const base = new URL( baseUrl(), window.location.origin );
	const [ pathPart, queryPart ] = path.split( '?' );
	const extraParams = new URLSearchParams( queryPart );

	if ( base.searchParams.has( 'rest_route' ) ) {
		base.searchParams.set( 'rest_route', base.searchParams.get( 'rest_route' ) + pathPart );
	} else {
		base.pathname = base.pathname.replace( /\/$/, '' ) + pathPart;
	}

	extraParams.forEach( ( value, key ) => base.searchParams.append( key, value ) );

	return base.toString();
}

/**
 * Generic Persian fallback for whenever a real, translated error message
 * isn't available — a raw HTTP reason phrase (res.statusText, always
 * English: "Not Found", "Internal Server Error") or a browser network
 * error must never reach the user directly. Every caller that renders
 * ApiError.message to the UI relies on this never being an English string.
 */
const GENERIC_REQUEST_ERROR = 'در انجام این درخواست مشکلی پیش آمد. لطفاً دوباره تلاش کنید.';

async function request<T>( path: string, options: RequestInit = {} ): Promise<T> {
	let res: Response;
	try {
		res = await fetch( buildUrl( path ), {
			...options,
			headers: {
				'Content-Type': 'application/json',
				...( window.BeauClick?.nonce ? { 'X-WP-Nonce': window.BeauClick.nonce } : {} ),
				...options.headers,
			},
			credentials: 'same-origin',
		} );
	} catch {
		// A real network failure (offline, DNS, CORS) never even reaches a
		// response — there is no res.statusText to (correctly) avoid here,
		// but the browser's own TypeError message would be just as raw and
		// English if allowed through unwrapped.
		throw new ApiError( 'bc_network_error', GENERIC_REQUEST_ERROR, 0 );
	}

	// A non-JSON response (a PHP fatal producing an HTML error page, a
	// proxy/WAF block page, a route that doesn't exist) must degrade to the
	// same generic Persian message, not an unhandled JSON-parse exception.
	const body: Partial<ApiEnvelope<T>> & { code?: string; message?: string } = await res.json().catch( () => ( {} ) );

	if ( ! res.ok || body.error ) {
		// Two different error shapes reach this point: the app's own
		// {data,meta,error:{code,message}} envelope (Response::error() in
		// every beauclick controller), and WordPress core's native
		// {code,message,data} shape -- the latter happens whenever a route's
		// permission_callback rejects the request (e.g. require_login()'s
		// WP_Error), since that's handled by WP_REST_Server itself before
		// the request ever reaches the controller that would wrap it in the
		// app's own envelope. Both carry a real, already-Persian message
		// today; check both before falling back to the generic string.
		throw new ApiError(
			body.error?.code ?? body.code ?? 'bc_unknown_error',
			body.error?.message ?? body.message ?? GENERIC_REQUEST_ERROR,
			res.status
		);
	}

	return body.data as T;
}

export const api = {
	get: <T,>( path: string ) => request<T>( path ),
	post: <T,>( path: string, payload?: unknown ) => request<T>( path, { method: 'POST', body: payload ? JSON.stringify( payload ) : undefined } ),
	patch: <T,>( path: string, payload?: unknown ) => request<T>( path, { method: 'PATCH', body: payload ? JSON.stringify( payload ) : undefined } ),
	del: <T,>( path: string ) => request<T>( path, { method: 'DELETE' } ),
};
