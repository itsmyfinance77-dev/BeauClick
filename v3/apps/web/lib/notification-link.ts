import { safeReturnPath } from './safe-return';

/**
 * Where a notification's `deepLink` may actually take the customer.
 *
 * The server names a destination per template (`template.registry.ts`), and
 * nine of its eighteen templates name one this app does not have yet:
 * `/chat`, `/privacy`, `/referral`. Rendering those as a link sends a
 * customer who tapped «مشاهده» to a 404 — a broken promise on the one screen
 * whose whole job is to send them somewhere.
 *
 * So a deep link is followed only when it is BOTH a same-origin path (the same
 * rule the login redirect uses, since a server-supplied link is untrusted data
 * in the way a `?next=` is) AND a route that exists. Anything else renders no
 * link at all; the notification is still shown and can still be marked read.
 *
 * Add a route here in the same change that builds its page.
 * `notification-link.spec.ts` fails if an entry has no page, and lists every
 * template destination that is still waiting for one.
 */
export const NOTIFICATION_ROUTES: readonly string[] = ['/bookings', '/dashboard', '/loyalty', '/waitlist'];

export function notificationHref(deepLink: string | null | undefined): string | null {
  const path = safeReturnPath(deepLink);
  if (!path) return null;
  const pathname = path.split(/[?#]/)[0];
  return NOTIFICATION_ROUTES.includes(pathname) ? path : null;
}
