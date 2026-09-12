import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The local Compose stack and CI must pull MinIO from the same, still-served
 * registry -- V3.3 infrastructure bug #146.
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
 * ## What is pinned, and what is deliberately not
 *
 * Pinned: Compose's object-storage image is a Quay `minio/minio` reference
 * with an explicit immutable `RELEASE.` tag (never `latest`, never Docker
 * Hub), CI pulls from the same registry and repository, and the MinIO
 * contract the suites depend on -- `server /data`, the `/minio/health/live`
 * probe -- is intact. NOT pinned: that CI and Compose name the identical
 * tag. CI tracks `latest` by an earlier decision and a single centrally
 * defined version is a later deduplication (#146 non-goal); this file says
 * so rather than quietly asserting it.
 */
const WORKSPACE = resolve(__dirname, '../../../..');
const REPO = resolve(WORKSPACE, '..');

const compose = readFileSync(resolve(WORKSPACE, 'infra/docker/docker-compose.yml'), 'utf8');
const ci = readFileSync(resolve(REPO, '.github/workflows/v3-ci.yml'), 'utf8');

const QUAY_MINIO = 'quay.io/minio/minio';

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

describe('the local object-storage image is pulled from the registry CI proves (#146)', () => {
  it('Compose names a Quay minio/minio image with an explicit immutable RELEASE tag', () => {
    const image = composeObjectStorageImage();
    expect(image.startsWith(`${QUAY_MINIO}:`)).toBe(true);
    expect(image).toMatch(/^quay\.io\/minio\/minio:RELEASE\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
  });

  it('Compose never returns to the withdrawn Docker Hub reference, and never floats on latest', () => {
    const image = composeObjectStorageImage();
    expect(image).not.toMatch(/^(docker\.io\/)?minio\/minio/);
    expect(image).not.toMatch(/:latest$/);
    // The literal that broke fresh machines, asserted absent from the whole file.
    expect(compose).not.toContain('image: minio/minio');
  });

  it('CI pulls from the same registry and repository, so a fresh machine and CI cannot drift apart in source', () => {
    expect(ciObjectStorageImage().startsWith(`${QUAY_MINIO}:`)).toBe(true);
    expect(ci).not.toMatch(/^\s+minio\/minio:\S+ server \/data/m);
  });

  it('the MinIO contract the suites rely on is intact: the server command and the liveness probe', () => {
    const service = compose.slice(compose.indexOf('\n  objectstorage:\n'));
    expect(service).toMatch(/^\s+command: server \/data$/m);
    expect(service).toContain('/minio/health/live');
    expect(service).toContain("ports: ['9100:9000']");
    expect(service).toContain('container_name: bc-v3-minio');
  });

  it('would catch the exact regression, so the assertions above are not vacuous', () => {
    // The pre-#146 line, run through the same matchers.
    const withdrawn = 'minio/minio:latest';
    expect(withdrawn.startsWith(`${QUAY_MINIO}:`)).toBe(false);
    expect(withdrawn).toMatch(/^(docker\.io\/)?minio\/minio/);
    expect(withdrawn).toMatch(/:latest$/);
  });
});
