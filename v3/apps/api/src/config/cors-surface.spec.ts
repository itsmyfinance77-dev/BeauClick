import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The CORS allow-lists must not drift from what the application actually uses.
 *
 * ## The bug this exists to make impossible
 *
 * A browser refuses a credentialed cross-origin request whose method or headers
 * the preflight response does not name. The request is never issued, so the
 * server sees nothing, logs nothing, and every server-side test passes.
 *
 * This has now happened twice in the same option object in `main.ts`:
 *
 *  * `Idempotency-Key` was missing from `allowedHeaders`. `POST /v1/bookings`
 *    requires the header and `booking-api.ts` sends it, so customer checkout
 *    failed in every real browser. Found by driving the flow by hand.
 *  * `PUT` was missing from `methods` (#311). Thirteen `@Put` routes exist and
 *    apps/web calls seven of them, so every "save an existing draft" on the
 *    commercial-catalogue screens, and the professional's outcome-policy
 *    assignment, failed in every real browser. Found by an audit, not by use.
 *
 * **No CI gate could see either.** `supertest` calls the Nest application
 * directly: there is no browser, no origin and therefore no preflight, so the
 * entire CORS configuration is invisible to the suite by construction. That is
 * the same shape as `runtime-path-map.spec.ts`'s container-only failure, and it
 * gets the same remedy.
 *
 * ## Why a comparison test rather than deriving the lists at boot
 *
 * Deriving `methods` from Nest's route table at bootstrap would be correct and
 * unreviewable: it reads private Express router internals, and it would let the
 * allow-list widen silently the moment somebody adds a verb. The allow-list is
 * a security boundary and deserves to stay hand-written, with a reviewer and a
 * diff. What should not be hand-maintained is the *memory* that the two must
 * agree -- so that becomes this test. Same trade `runtime-path-map.spec.ts`
 * makes, and for the same reason.
 *
 * ## Direction of each assertion
 *
 * Methods are compared for EQUALITY. The set the controllers declare, plus
 * `OPTIONS` for the preflight itself, is exactly what should be allowed --
 * a verb nobody serves has no business being advertised.
 *
 * Headers are compared as a SUBSET: every header apps/web sets must be allowed.
 * Equality would be wrong, because `X-Device-Label` is accepted for clients
 * that are not this web app.
 */

const V3_ROOT = resolve(__dirname, '../../../..');
const MAIN_TS = join(V3_ROOT, 'apps/api/src/main.ts');

/** Source roots that hold HTTP controllers. */
const CONTROLLER_ROOTS = ['services', 'libs', 'apps/api/src'];

/** Where apps/web builds its outgoing requests. */
const WEB_CLIENT_ROOT = join(V3_ROOT, 'apps/web/lib');

function filesUnder(dir: string, matches: (name: string) => boolean, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) filesUnder(full, matches, found);
    else if (matches(entry)) found.push(full);
  }
  return found;
}

/** The literal string array assigned to `key:` inside `main.ts`'s `enableCors` call. */
function corsList(key: 'methods' | 'allowedHeaders'): string[] {
  const src = readFileSync(MAIN_TS, 'utf8');
  const match = new RegExp(`\\n\\s*${key}:\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!match) throw new Error(`Could not find a \`${key}\` array in ${MAIN_TS}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const controllerFiles = CONTROLLER_ROOTS.flatMap((r) => filesUnder(join(V3_ROOT, r), (n) => n.endsWith('.controller.ts')));

/** Every HTTP verb any controller declares, upper-cased. */
function declaredVerbs(): Set<string> {
  const verbs = new Set<string>();
  for (const file of controllerFiles) {
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s*@(Get|Post|Put|Patch|Delete|Head|All)\(/gm)) {
      verbs.add(m[1].toUpperCase());
    }
  }
  return verbs;
}

/** Every request header apps/web sets by name. */
function headersWebSets(): Set<string> {
  const headers = new Set<string>();
  for (const file of filesUnder(WEB_CLIENT_ROOT, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/headers\[\s*'([^']+)'\s*\]\s*=/g)) headers.add(m[1]);
    for (const m of src.matchAll(/'(Idempotency-Key|X-[A-Za-z-]+)'\s*:/g)) headers.add(m[1]);
  }
  return headers;
}

describe('the CORS allow-lists match what the application uses', () => {
  it('finds the sources it is supposed to be comparing', () => {
    // Without this, a walk that returned nothing would make every assertion
    // below vacuously true -- the failure mode that lets a drift test rot.
    expect(controllerFiles.length).toBeGreaterThan(40);
    expect(corsList('methods').length).toBeGreaterThan(0);
    expect(corsList('allowedHeaders').length).toBeGreaterThan(0);
    expect([...headersWebSets()]).toContain('Authorization');
  });

  it('allows exactly the verbs the controllers declare, plus OPTIONS for the preflight', () => {
    const expected = [...declaredVerbs(), 'OPTIONS'].sort();
    expect(corsList('methods').sort()).toEqual(expected);
  });

  it('allows every header apps/web sets', () => {
    const allowed = corsList('allowedHeaders');
    // Named individually rather than as a set difference, so a failure says
    // WHICH header a browser would reject the request for.
    for (const header of [...headersWebSets()].sort()) {
      expect(allowed).toContain(header);
    }
  });

  it('names PUT, the verb whose absence broke seven write operations (#311)', () => {
    // Redundant with the equality assertion above by construction, and kept
    // deliberately: it is the one that will read as a sentence in a diff if
    // somebody ever proposes trimming this list.
    expect(corsList('methods')).toContain('PUT');
  });
});
