import { API_BASE_URL } from './config';

/**
 * Is this sandbox-gateway return URL one we are willing to navigate to?
 *
 * The sandbox checkout page receives its return address as an ordinary query
 * parameter (`?callback=...`), which makes it entirely attacker-chosen.
 * Navigating there unchecked turns that page into an open redirect:
 *
 *   /sandbox-gateway?reference=x&callback=https://evil.example
 *
 * renders a plausible BeauClick payment screen and then lands the visitor on
 * someone else's site. The page is a static frontend route with no
 * server-side gate of its own -- the sandbox PROVIDER is disabled in
 * production, but the PAGE still renders -- so it cannot rely on the API's
 * gate to be safe.
 *
 * The legitimate value is always the API's own callback endpoint
 * (`${PUBLIC_API_BASE_URL}/v1/payments/callback/<provider>`, constructed
 * server-side in SandboxPaymentProvider.initiate), so requiring the
 * configured API's origin is exact rather than approximate.
 *
 * Lives in lib/ rather than beside the page because App Router page modules
 * may not carry arbitrary named exports, and this needs to be directly
 * testable -- an allowlist that is never exercised tends to drift back open.
 */
export function isAllowedCallback(candidate: string, currentOrigin: string): boolean {
  try {
    // Relative URLs resolve against the current page and so can never point
    // off-origin; they are still parsed here rather than special-cased.
    const target = new URL(candidate, currentOrigin);
    // Blocks javascript:, data: and friends, which `new URL` parses happily.
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    return target.origin === new URL(API_BASE_URL, currentOrigin).origin;
  } catch {
    return false;
  }
}
