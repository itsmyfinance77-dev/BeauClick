import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFICATION_ROUTES, notificationHref } from '@/lib/notification-link';

/**
 * A notification's deep link is server data, and it points at pages this app
 * may not have. These tests keep the two lists honest against each other:
 * what the server sends, and what the web app can open.
 */

const WEB = join(__dirname, '..');
const REGISTRY = join(WEB, '../../services/notification/src/templates/template.registry.ts');

/** Every distinct `deepLink: '/x'` the server's templates name. */
function templateDestinations(): string[] {
  const source = readFileSync(REGISTRY, 'utf8');
  return [...new Set([...source.matchAll(/deepLink:\s*'([^']*)'/g)].map((m) => m[1]))].sort();
}

/**
 * Destinations the server already names whose page is not built. Each is a
 * named piece of work; when the page lands, move the path into
 * `NOTIFICATION_ROUTES` and delete it here — the last test fails until you do.
 */
const NOT_BUILT_YET: Record<string, string> = {
  '/chat': 'spec 36, story #237',
  '/privacy': 'spec 29 (/account/privacy), story #236',
};

describe('notificationHref', () => {
  it('follows a link to a page that exists, keeping its query and fragment', () => {
    expect(notificationHref('/bookings')).toBe('/bookings');
    expect(notificationHref('/waitlist?offer=1#top')).toBe('/waitlist?offer=1#top');
    // The referral notifications' deep link, now that the page exists.
    expect(notificationHref('/referral')).toBe('/referral');
  });

  it('renders no link for a page that does not exist yet, rather than a link that 404s', () => {
    expect(notificationHref('/chat')).toBeNull();
    expect(notificationHref('/privacy')).toBeNull();
  });

  it.each([
    'https://evil.example/bookings',
    '//evil.example/bookings',
    '/\\evil.example',
    'javascript:alert(1)',
    'bookings',
    '',
  ])('refuses %j — a server-supplied link is untrusted the way a ?next= is', (value) => {
    expect(notificationHref(value)).toBeNull();
  });

  it('is not fooled by a real path used as a prefix of another', () => {
    expect(notificationHref('/bookings-archive')).toBeNull();
    expect(notificationHref('/bookings/../admin')).toBeNull();
  });

  it('treats a missing link as no link', () => {
    expect(notificationHref(null)).toBeNull();
    expect(notificationHref(undefined)).toBeNull();
  });
});

describe('the allow-list against the app and the server', () => {
  it('finds the server registry it is supposed to be reading', () => {
    // Guards against passing forever because the path moved.
    expect(templateDestinations().length).toBeGreaterThan(3);
  });

  it('lists only routes that have a page', () => {
    const missing = NOTIFICATION_ROUTES.filter((route) => !existsSync(join(WEB, 'app', route, 'page.tsx')));
    expect(missing).toEqual([]);
  });

  it('accounts for every destination the server names: followable, or on the not-built list — never neither', () => {
    const unaccounted = templateDestinations().filter(
      (path) => !NOTIFICATION_ROUTES.includes(path) && !(path in NOT_BUILT_YET),
    );
    expect(unaccounted).toEqual([]);
  });

  it('does not keep a destination on the not-built list once its page exists', () => {
    const stale = Object.keys(NOT_BUILT_YET).filter((path) => existsSync(join(WEB, 'app', path, 'page.tsx')));
    expect(stale).toEqual([]);
  });
});
