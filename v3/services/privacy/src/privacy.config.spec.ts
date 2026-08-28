import { ConfigService } from '@nestjs/config';

import { PrivacyConfig } from './privacy.config';
import { PrivacySweepService } from './privacy-sweep.service';
import { PrivacyService } from './privacy.service';

function configWith(values: Record<string, string | number | undefined>): PrivacyConfig {
  return new PrivacyConfig({ get: (key: string) => values[key] } as unknown as ConfigService);
}

/**
 * The two things about privacy that are worth proving without a database.
 *
 * **A misconfigured number must not become a dangerous number.** Every value
 * here is environment-tunable because `GAP-10` says the figures are
 * provisional — and that tunability is exactly what makes a typo reachable. A
 * grace window of `0` is not a short grace window; it is deletion with no way
 * back, arrived at by someone clearing an environment variable. Falling back to
 * the documented default is the correct response to nonsense, and it is a
 * property rather than an implementation detail.
 *
 * **The sweep's order is load-bearing.** It reclaims, expires, generates, and
 * only then erases — because erasure is the one step that cannot be undone,
 * and a pass that dies should die before it rather than after.
 */
describe('PrivacyConfig', () => {
  it('uses the documented defaults when nothing is set', () => {
    const config = configWith({});
    expect(config.erasureGraceHours).toBe(168);
    expect(config.exportTtlHours).toBe(72);
    expect(config.sweepIntervalMs).toBe(60_000);
    expect(config.stalledProcessingMinutes).toBe(15);
  });

  it('honours a real override', () => {
    const config = configWith({ PRIVACY_ERASURE_GRACE_HOURS: '24', PRIVACY_EXPORT_TTL_HOURS: 6 });
    expect(config.erasureGraceHours).toBe(24);
    expect(config.exportTtlHours).toBe(6);
  });

  it('refuses a zero grace window — that is not a short window, it is no window at all', () => {
    expect(configWith({ PRIVACY_ERASURE_GRACE_HOURS: '0' }).erasureGraceHours).toBe(168);
  });

  it('refuses a negative or unparseable value rather than propagating it', () => {
    expect(configWith({ PRIVACY_ERASURE_GRACE_HOURS: '-5' }).erasureGraceHours).toBe(168);
    expect(configWith({ PRIVACY_ERASURE_GRACE_HOURS: 'soon' }).erasureGraceHours).toBe(168);
    expect(configWith({ PRIVACY_EXPORT_TTL_HOURS: '' }).exportTtlHours).toBe(72);
  });
});

describe('PrivacySweepService', () => {
  function stubPrivacy(overrides: Partial<Record<keyof PrivacyService, unknown>> = {}) {
    const calls: string[] = [];
    const record =
      <T>(name: string, result: T) =>
      async () => {
        calls.push(name);
        return result;
      };

    const stub = {
      reclaimStalled: record('reclaim', 0),
      expireStaleExports: record('expire', 0),
      pendingExports: record('pendingExports', [] as string[]),
      generateExport: record('generate', true),
      dueErasures: record('dueErasures', [] as Array<{ id: string; subjectUserId: string }>),
      executeErasure: record('erase', []),
      ...overrides,
    };

    return { stub: stub as unknown as PrivacyService, calls };
  }

  it('reclaims, expires, generates, and erases — in that order', async () => {
    const { stub, calls } = stubPrivacy({
      pendingExports: async () => ['export-1'],
      dueErasures: async () => [{ id: 'erasure-1', subjectUserId: 'user-1' }],
    });

    const result = await new PrivacySweepService(stub).runOnce();

    // Reclaim FIRST, so work a dead process abandoned is back in `pending`
    // before this pass looks for pending work. Erase LAST, because it is the
    // only irreversible step.
    expect(calls).toEqual(['reclaim', 'expire', 'generate', 'erase']);
    expect(result.exportsGenerated).toBe(1);
    expect(result.erasuresExecuted).toBe(1);
  });

  it('one subject’s failed erasure does not abandon the rest of the queue', async () => {
    const erased: string[] = [];
    const { stub } = stubPrivacy({
      dueErasures: async () => [
        { id: 'bad', subjectUserId: 'u1' },
        { id: 'good', subjectUserId: 'u2' },
      ],
      executeErasure: async (id: string) => {
        if (id === 'bad') throw new Error('one subject blew up');
        erased.push(id);
        return [];
      },
    });

    const result = await new PrivacySweepService(stub).runOnce();

    expect(result.erasuresFailed).toBe(1);
    expect(result.erasuresExecuted).toBe(1);
    expect(erased).toEqual(['good']);
  });

  it('uses the composition root’s runner when one is bound, so stored bytes are purged too', async () => {
    // Unbound, the sweep erases correctly and leaves orphaned objects in the
    // store. The runner is the seam that lets `apps/api` bracket the erasure
    // with the byte purge without privacy importing media.
    const ran: Array<[string, string]> = [];
    const { stub, calls } = stubPrivacy({
      dueErasures: async () => [{ id: 'r1', subjectUserId: 'u1' }],
    });

    const result = await new PrivacySweepService(stub, {
      run: async (requestId, subjectUserId) => {
        ran.push([requestId, subjectUserId]);
      },
    }).runOnce();

    expect(ran).toEqual([['r1', 'u1']]);
    expect(result.erasuresExecuted).toBe(1);
    // The service's own executeErasure was NOT called directly -- the runner owns it.
    expect(calls).not.toContain('erase');
  });
});
