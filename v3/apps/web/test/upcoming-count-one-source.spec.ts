import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The upcoming-bookings count is computed in exactly one place — #282.
 *
 * Two surfaces show this number: the navigation's badge beside «رزروها» and
 * `/pro/bookings`'s «پیش‌رو» tab label. They used to be different numbers under
 * one word — the tab counted the pages it HELD and marked the shortfall with a
 * `+`, the badge did not exist — and the whole point of the route this story
 * added is that there is now one answer for both.
 *
 * `pro-bookings-page.spec.tsx` asserts they AGREE, by serving a count that
 * contradicts the rows on screen. That catches a divergence once it exists. This
 * file is the other half: it asserts there is only one place a second number
 * could come FROM, so re-deriving one of them breaks the build rather than
 * shipping and being noticed by a reader who cannot tell which figure is real.
 *
 * Deliberately a source-level check, in the idiom `breakpoints.spec.ts` and
 * `css-module-classes.spec.ts` already use for rules no rendered DOM can show.
 */

const WEB = join(__dirname, '..');
const ROUTE = '/v1/me/professional-bookings/upcoming-count';
const FETCHER = 'upcomingBookingCount';

/** Every TypeScript source under `app/`, `components/` and `lib/`, tests excluded. */
function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, found);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(full);
  }
  return found;
}

const all = ['app', 'components', 'lib'].flatMap((d) => sources(join(WEB, d)));
const rel = (file: string) => file.slice(WEB.length + 1).replace(/\\/g, '/');
const naming = (needle: string) => all.filter((file) => readFileSync(file, 'utf8').includes(needle)).map(rel);

describe('the upcoming-bookings count has one source', () => {
  it('finds the files it is supposed to be checking', () => {
    // A guard against the walk silently returning nothing, which would make
    // every assertion below vacuously true.
    expect(all.length).toBeGreaterThan(50);
    expect(all.map(rel)).toContain('lib/pro-api.ts');
    expect(all.map(rel)).toContain('lib/pro-context.tsx');
  });

  it('names the route in exactly one file, the API client', () => {
    // A second caller would be a second request and, sooner or later, a second
    // number — the two could be read at different instants either way.
    expect(naming(ROUTE)).toEqual(['lib/pro-api.ts']);
  });

  it('is fetched from exactly one place, the shared provider', () => {
    // `lib/pro-api.ts` declares it; `lib/pro-context.tsx` is the only caller.
    // Any screen that wants the number reads it off the context instead.
    expect(naming(`${FETCHER}(`).sort()).toEqual(['lib/pro-api.ts', 'lib/pro-context.tsx']);
  });

  it('is held in exactly one piece of state', () => {
    expect(naming('setUpcomingBookings')).toEqual(['lib/pro-context.tsx']);
  });

  it('is named by four files and no others, each for a different reason', () => {
    /*
     * An exact set rather than a count, so a fifth file has to be argued for
     * here before it can exist:
     *
     *   lib/pro-context.tsx        holds it — the one source
     *   components/pro-shell.tsx   shows it — the column badge
     *   app/pro/bookings/page.tsx  shows it — the «پیش‌رو» tab label
     *   components/pro-nav.ts      NAMES it — `badge: 'upcomingBookings'` says
     *                              which destination carries which count, and
     *                              deliberately holds no number
     */
    expect(naming('upcomingBookings').sort()).toEqual(
      ['app/pro/bookings/page.tsx', 'components/pro-nav.ts', 'components/pro-shell.tsx', 'lib/pro-context.tsx'].sort(),
    );
  });
});

/**
 * The one copy of the status classification this repository cannot avoid — #282.
 *
 * `apps/web` may not import `services/booking`; the dependency does not go that
 * way. So `pro-bookings-page.spec.tsx`'s fake server restates
 * `CONCLUDED_BOOKING_STATUSES` to work out what a real server would count, and a
 * restatement with no link back to its original is a drift waiting to happen.
 *
 * Read off disk rather than documented, which is the same reason the assertions
 * above are: a comment saying "update this if the server changes" is a hope, and
 * a test is a consequence. `booking-state-machine.spec.ts` covers the server side
 * of the same classification from inside the service.
 */
describe('the web fixture agrees with the server it is standing in for', () => {
  const ENTITY = join(WEB, '..', '..', 'services', 'booking', 'src', 'entities', 'booking.entity.ts');

  /** The members of a `readonly BookingStatus[]` literal, or null when the shape moved. */
  function declaredList(source: string, name: string): string[] | null {
    const match = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source);
    if (!match) return null;
    return match[1]
      .split(',')
      .map((part) => part.trim().replace(/^'|'$/g, ''))
      .filter((part) => part.length > 0);
  }

  it('can still find both lists, so a silently-unmatched regex cannot pass this', () => {
    /*
     * The failure `css-module-classes.spec.ts` was corrected for: a parser that
     * sees nothing and reports success. Both extractions are asserted to have
     * found something before they are compared.
     *
     * Non-empty rather than a fixed length, deliberately. Pinning `4` here would
     * mean a concluded set that legitimately grows to five fails THIS test first,
     * with a message about a length — the wrong reason, pointing at the wrong
     * thing. The comparison below is what should speak about a disagreement, and
     * it already covers the count.
     */
    expect(declaredList(readFileSync(ENTITY, 'utf8'), 'CONCLUDED_BOOKING_STATUSES')?.length).toBeGreaterThan(0);
    expect(
      declaredList(readFileSync(join(WEB, 'test/pro-bookings-page.spec.tsx'), 'utf8'), 'FIXTURE_CONCLUDED_STATUSES')
        ?.length,
    ).toBeGreaterThan(0);
  });

  it('restates exactly the server’s concluded statuses, so changing one breaks the other', () => {
    const server = declaredList(readFileSync(ENTITY, 'utf8'), 'CONCLUDED_BOOKING_STATUSES');
    const fixture = declaredList(readFileSync(join(WEB, 'test/pro-bookings-page.spec.tsx'), 'utf8'), 'FIXTURE_CONCLUDED_STATUSES');

    expect(fixture?.slice().sort()).toEqual(server?.slice().sort());
  });
});
