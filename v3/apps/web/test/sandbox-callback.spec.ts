import { isAllowedCallback } from '@/lib/sandbox-callback';

/**
 * The sandbox checkout page takes its return address from a query parameter
 * and then navigates the browser to it. Unchecked, that is an open redirect
 * on a page that looks like a BeauClick payment screen -- and the page is a
 * static frontend route, so the API's production gate on the sandbox
 * PROVIDER does not stop the PAGE from rendering and redirecting.
 *
 * These pin the allowlist. NEXT_PUBLIC_API_BASE_URL is unset in the test
 * environment, so config.ts falls back to http://localhost:3099/api.
 */
const ORIGIN = 'http://localhost:3100';

describe('sandbox gateway return-URL allowlist', () => {
  it('allows the API callback the gateway is actually initiated with', () => {
    expect(isAllowedCallback('http://localhost:3099/api/v1/payments/callback/sandbox', ORIGIN)).toBe(true);
  });

  it('allows any path on the configured API origin', () => {
    expect(isAllowedCallback('http://localhost:3099/anything', ORIGIN)).toBe(true);
  });

  it('refuses a different host', () => {
    expect(isAllowedCallback('https://evil.example/steal', ORIGIN)).toBe(false);
    expect(isAllowedCallback('https://evil.example', ORIGIN)).toBe(false);
  });

  it('refuses a lookalike host that merely CONTAINS the allowed one', () => {
    // The failure mode a naive `startsWith`/`includes` check would have.
    expect(isAllowedCallback('http://localhost:3099.evil.example/cb', ORIGIN)).toBe(false);
    expect(isAllowedCallback('http://evil.example/http://localhost:3099/api', ORIGIN)).toBe(false);
  });

  it('refuses a different port on the same host', () => {
    expect(isAllowedCallback('http://localhost:1234/cb', ORIGIN)).toBe(false);
  });

  it('refuses non-http schemes that new URL() parses happily', () => {
    expect(isAllowedCallback('javascript:alert(1)', ORIGIN)).toBe(false);
    expect(isAllowedCallback('data:text/html,<script>alert(1)</script>', ORIGIN)).toBe(false);
  });

  it('refuses a protocol-relative URL, which resolves off-origin', () => {
    expect(isAllowedCallback('//evil.example/cb', ORIGIN)).toBe(false);
  });

  it('refuses junk rather than throwing', () => {
    expect(isAllowedCallback('', ORIGIN)).toBe(false);
    expect(isAllowedCallback('http://', ORIGIN)).toBe(false);
  });

  it('refuses a same-origin-as-the-WEB-app URL, since the callback belongs to the API', () => {
    // The web app's own origin is not the API's; only the API's callback
    // endpoint is a legitimate destination here.
    expect(isAllowedCallback('http://localhost:3100/checkout/result?status=succeeded', ORIGIN)).toBe(false);
  });
});
