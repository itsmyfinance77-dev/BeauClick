import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The local Compose stack and CI must pull object storage from the same,
 * still-served registry -- V3.3 infrastructure bug #146, and now #305.
 *
 * ## The failure this exists to make visible
 *
 * On 2026-09-11 Docker Hub stopped serving `minio/minio` (`pull access
 * denied ... repository does not exist`). CI broke at once and was repaired
 * (#145, `quay.io/minio/minio`). `infra/docker/docker-compose.yml` still said
 * `minio/minio:latest` -- and nobody noticed, because every machine that had
 * ever started the stack held the image in its local cache and kept working.
 * Only a FRESH machine failed. No test, typecheck, lint, build or CI job reads
 * the Compose file, so this is the same shape as the runtime path map's
 * defect next door: a break that every gate is blind to until somebody
 * provisions a new environment.
 *
 * ## It happened again, and this file caught it (#305)
 *
 * On 2026-09-24 quay.io began requiring authentication for anonymous access.
 * `docker run` returned "unauthorized" and the real-Postgres job died before a
 * single test ran, on every branch and on master. The repair moved both CI and
 * Compose to `chainguard/minio` -- the same MinIO server, a different
 * publisher -- and **this spec failed on that change**, which is the whole
 * point of it existing. The assertions below were rewritten deliberately, not
 * relaxed to let the change through.
 *
 * ## What changed in what this pins, and why
 *
 * The old rule was "a Quay `minio/minio` reference with an explicit immutable
 * `RELEASE.` tag, never `latest`". Both halves had to go, for reasons the
 * outage taught:
 *
 *   - **The registry moved**, because Quay stopped answering. Pinning is what
 *     this file used to demand; it would not have helped. Two dated releases
 *     return 401 exactly as `latest` does, so Quay restricted the whole
 *     repository rather than a tag. Compose's *pinned* reference broke in the
 *     same outage as CI's floating one.
 *   - **`latest` is now correct**, which reverses the old rule. Chainguard's
 *     public repository keeps exactly two real tags (`latest`, `latest-dev`)
 *     and publishes `.sig` signature artifacts for the rest; a digest there is
 *     garbage-collected on their rebuild cycle. Pinning would trade a tag that
 *     moves for a reference that DISAPPEARS -- the same outage in a worse
 *     form, arriving with nobody having changed anything.
 *
 * So the invariant this file defends is no longer "pin the tag". It is the one
 * that actually held through both outages: **CI and Compose must name the same
 * image, and must never return to a registry that has already withdrawn it.**
 * The previous version explicitly did NOT assert that the two matched, calling
 * a shared version a later deduplication. They match now, so it is asserted --
 * that drift is the thing that let Compose sit broken and unnoticed for two
 * weeks.
 *
 * `--user 0` is pinned too, and it is not tidiness: the Chainguard image runs
 * as non-root uid 65532 and cannot write its backend directory, exiting
 * immediately with "FATAL Unable to initialize backend: file access denied".
 * A writable path under `/tmp` does not fix it and neither does a volume with
 * matching ownership; both were tried. Someone removing it as needless
 * hardening-noise would break both stacks, so it is asserted on both sides.
 */
const WORKSPACE = resolve(__dirname, '../../../..');
const REPO = resolve(WORKSPACE, '..');

const compose = readFileSync(resolve(WORKSPACE, 'infra/docker/docker-compose.yml'), 'utf8').replace(/\r\n/g, '\n');
const ci = readFileSync(resolve(REPO, '.github/workflows/v3-ci.yml'), 'utf8').replace(/\r\n/g, '\n');

/** The registries that have already withdrawn this image. Neither may come back. */
const WITHDRAWN = [
  { name: 'Docker Hub `minio/minio`', pattern: /(^|\s)(docker\.io\/)?minio\/minio[:@]/ },
  { name: 'quay.io', pattern: /quay\.io\// },
];

/** The `image:` line of the `objectstorage` service, and only that service. */
function composeObjectStorageImage(): string {
  const service = compose.slice(compose.indexOf('\n  objectstorage:\n'));
  const match = /^\s+image:\s*(\S+)\s*$/m.exec(service);
  if (!match) throw new Error('objectstorage service declares no image');
  return match[1];
}

/** The image the CI step actually runs -- the token before `server /data`. */
function ciObjectStorageImage(): string {
  const match = /^\s+(\S+) server \/data\s*$/m.exec(ci);
  if (!match) throw new Error('v3-ci.yml starts no `server /data` container');
  return match[1];
}

describe('object storage comes from one still-served registry, in CI and locally (#146, #305)', () => {
  it('CI and Compose name the IDENTICAL image, so a fresh machine and CI cannot drift apart', () => {
    // The drift that let Compose sit broken and unnoticed for two weeks after
    // #145 repaired CI alone.
    expect(composeObjectStorageImage()).toBe(ciObjectStorageImage());
  });

  it('neither returns to a registry that has already withdrawn this image', () => {
    // Over the image REFERENCES, not the file text: both files carry comments
    // naming Docker Hub and Quay to record why they were left, and a matcher
    // that read those would fail on its own documentation.
    const references = [
      { side: 'compose', image: composeObjectStorageImage() },
      { side: 'ci', image: ciObjectStorageImage() },
      // Every other `image:` in Compose too, so a second service cannot
      // quietly reintroduce a withdrawn registry.
      ...[...compose.matchAll(/^\s+image:\s*(\S+)\s*$/gm)].map((m) => ({ side: 'compose', image: m[1] })),
    ];

    for (const { side, image } of references) {
      for (const { name, pattern } of WITHDRAWN) {
        expect({ side, image, withdrawn: name, used: pattern.test(` ${image}`) }).toEqual({
          side,
          image,
          withdrawn: name,
          used: false,
        });
      }
    }
  });

  it('runs the container as root on both sides, which the Chainguard image requires to write its backend', () => {
    // Without this: "FATAL Unable to initialize backend: file access denied",
    // immediately, before any test runs. Easy to mistake for removable noise.
    expect(ci).toMatch(/docker run .*--user 0/);
    const service = compose.slice(compose.indexOf('\n  objectstorage:\n'));
    expect(service).toMatch(/^\s+user:\s*['"]?0['"]?\s*$/m);
  });

  it('the MinIO contract the suites rely on is intact: the server command and the liveness probe', () => {
    const service = compose.slice(compose.indexOf('\n  objectstorage:\n'));
    expect(service).toMatch(/^\s+command: server \/data$/m);
    expect(service).toContain('/minio/health/live');
    expect(service).toContain("ports: ['9100:9000']");
    expect(service).toContain('container_name: bc-v3-minio');
  });

  it('would catch both regressions that have actually happened, so the assertions above are not vacuous', () => {
    // Run the real matchers over the two references that broke this project,
    // rather than trusting that they would have been caught.
    const hub = 'minio/minio:latest';
    const quay = 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z';
    expect(WITHDRAWN.some(({ pattern }) => pattern.test(` ${hub}`))).toBe(true);
    expect(WITHDRAWN.some(({ pattern }) => pattern.test(` ${quay}`))).toBe(true);
    // And that a matching pair is what the first assertion demands: two
    // different images must not satisfy it.
    expect(hub).not.toBe(quay);
  });
});
