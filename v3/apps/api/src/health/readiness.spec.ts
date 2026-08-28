import {
  DEPENDENCIES,
  DependencyReadiness,
  EXTERNAL_VERIFICATION_LEDGER,
  READINESS_STATES,
  REQUIRED_FOR_TRAFFIC,
  allDependenciesReal,
  configurationVerdict,
  externalEnablementComplete,
  overallReadiness,
} from './readiness';

/**
 * The readiness vocabulary and the external-verification ledger.
 *
 * The service that fills these in is exercised against a real application in
 * `operability-readiness.pg-spec.ts`; what is pinned here is the part that
 * must hold regardless of any deployment -- above all that **nothing in this
 * repository can report an external dependency as production-verified**.
 */

function dep(overrides: Partial<DependencyReadiness>): DependencyReadiness {
  return {
    name: 'database',
    state: 'reachable',
    productionVerified: false,
    blockedBy: null,
    required: true,
    ...overrides,
  };
}

describe('readiness vocabulary', () => {
  it('gives every dependency a ledger row, so none can be silently unaccounted for', () => {
    for (const name of DEPENDENCIES) {
      expect(EXTERNAL_VERIFICATION_LEDGER[name]).toBeDefined();
      expect(REQUIRED_FOR_TRAFFIC[name]).toBeDefined();
    }
    expect(Object.keys(EXTERNAL_VERIFICATION_LEDGER).sort()).toEqual([...DEPENDENCIES].sort());
  });

  it('distinguishes a simulated dependency from an absent one and from a real one', () => {
    // The distinction the whole file exists for. A sandbox gateway is neither
    // "off" nor "working" -- it is a stand-in, and a vocabulary that cannot
    // say so is how V2's dev-only payment gateway stayed reachable.
    expect(READINESS_STATES).toContain('simulated');
    expect(READINESS_STATES).toContain('not_configured');
    expect(READINESS_STATES).toContain('configured');
  });

  describe('the external-verification ledger', () => {
    it('reports NOTHING as production-verified, because nothing has been', () => {
      // This assertion is meant to fail one day. When it does, the change that
      // broke it must be a person recording real live evidence -- the External
      // Enablement Gate being executed -- and not a code path that inferred
      // verification from a probe. There is deliberately no setter.
      for (const [name, entry] of Object.entries(EXTERNAL_VERIFICATION_LEDGER)) {
        expect({ name, verified: entry.verified }).toEqual({ name, verified: false });
      }
      expect(externalEnablementComplete()).toBe(false);
    });

    it('names the open gap and the evidence that would close it', () => {
      for (const entry of Object.values(EXTERNAL_VERIFICATION_LEDGER)) {
        if (!entry.verified) {
          // `GAP-06b`, `HOSTING_GRANTS`, `THROTTLE-STORE` -- the id shapes the
          // reconciliation document actually uses.
          expect(entry.gap).toMatch(/^[A-Z][A-Z0-9_-]*[A-Za-z0-9]$/);
          expect(entry.evidence.length).toBeGreaterThan(20);
        }
      }
    });

    it('points payment and SMS at the gaps the reconciliation document actually tracks', () => {
      expect(EXTERNAL_VERIFICATION_LEDGER.payment.gap).toBe('GAP-06b');
      expect(EXTERNAL_VERIFICATION_LEDGER.sms.gap).toBe('GAP-11');
      expect(EXTERNAL_VERIFICATION_LEDGER.database.gap).toBe('HOSTING_GRANTS');
      expect(EXTERNAL_VERIFICATION_LEDGER.throttle_store.gap).toBe('THROTTLE-STORE');
    });
  });

  describe('overallReadiness', () => {
    it('is ready when the required dependencies answer', () => {
      expect(
        overallReadiness([dep({ name: 'database' }), dep({ name: 'ledger' }), dep({ name: 'search', required: false })]),
      ).toBe('ready');
    });

    it('is NOT ready when a required dependency is unreachable', () => {
      expect(overallReadiness([dep({ name: 'database', state: 'unreachable' })])).toBe('not_ready');
      expect(overallReadiness([dep({ name: 'ledger', state: 'not_configured' })])).toBe('not_ready');
    });

    it('stays ready when a SIMULATED or optional dependency is the only problem', () => {
      // The rule that keeps a readiness probe from becoming an outage. A
      // missing SMS vendor is a launch blocker recorded in the ledger; it is
      // not a reason to pull every instance out of rotation, because no
      // restart can fix it and removing the instances also removes the pages
      // that tell customers what is going on.
      expect(
        overallReadiness([
          dep({ name: 'database' }),
          dep({ name: 'ledger' }),
          dep({ name: 'sms', state: 'simulated', required: false }),
          dep({ name: 'payment', state: 'simulated', required: false }),
          dep({ name: 'search', state: 'unreachable', required: false }),
          dep({ name: 'storage', state: 'not_configured', required: false }),
        ]),
      ).toBe('ready');
    });

    it('never treats a simulated REQUIRED dependency as a routing failure either', () => {
      // `simulated` means something is answering. It is a truthfulness
      // problem, not an availability one, and conflating the two would make
      // every development instance unroutable.
      expect(overallReadiness([dep({ name: 'database', state: 'simulated' })])).toBe('ready');
    });
  });

  describe('allDependenciesReal', () => {
    it('is false while any stand-in is serving', () => {
      expect(allDependenciesReal([dep({}), dep({ name: 'payment', state: 'simulated' })])).toBe(false);
      expect(allDependenciesReal([dep({}), dep({ name: 'sms', state: 'not_configured' })])).toBe(false);
    });

    it('is true only when every dependency has something real behind it', () => {
      expect(allDependenciesReal([dep({}), dep({ name: 'storage', state: 'configured' })])).toBe(true);
    });

    it('is still not the same claim as production-verified', () => {
      // A configured dependency is one whose settings are present. It says
      // nothing about whether one real OTP has arrived on a real phone or one
      // real rial has settled -- which is why these are two functions.
      const real = [dep({}), dep({ name: 'payment', state: 'configured' })];
      expect(allDependenciesReal(real)).toBe(true);
      expect(externalEnablementComplete()).toBe(false);
    });
  });

  describe('configurationVerdict', () => {
    const problems = [
      'CORS_ALLOWED_ORIGINS contains the loopback origin "http://localhost:3100", which is a development value.',
      'MEDIA_STORAGE_DRIVER=local is refused in production.',
    ];

    it('publishes ONLY a verdict in production', () => {
      // The reasons are not secret-bearing, but they are a configuration map:
      // they name origins, drivers, and which variables are unset. This
      // endpoint is public, unauthenticated, and rate-limit exempt.
      const verdict = configurationVerdict(true, problems);
      expect(verdict).toEqual({ valid: false });
      expect(JSON.stringify(verdict)).not.toContain('localhost');
    });

    it('includes the reasons everywhere else, where they are useful and there is nothing to protect', () => {
      expect(configurationVerdict(false, problems)).toEqual({ valid: false, problems });
    });

    it('reports valid with an empty problem list', () => {
      expect(configurationVerdict(true, [])).toEqual({ valid: true });
      expect(configurationVerdict(false, [])).toEqual({ valid: true, problems: [] });
    });

    it('copies the problems rather than aliasing the array it was given', () => {
      const source = [...problems];
      const verdict = configurationVerdict(false, source);
      source.push('mutated after the fact');
      expect(verdict.problems).toHaveLength(2);
    });
  });

  describe('REQUIRED_FOR_TRAFFIC', () => {
    it('requires only what makes an answer WRONG rather than reduced', () => {
      expect(REQUIRED_FOR_TRAFFIC.database).toBe(true);
      expect(REQUIRED_FOR_TRAFFIC.ledger).toBe(true);
      // Search has a degraded path; a reduced result page beats no page.
      expect(REQUIRED_FOR_TRAFFIC.search).toBe(false);
      // Checkout failing must not remove the pages that explain the failure.
      expect(REQUIRED_FOR_TRAFFIC.payment).toBe(false);
      expect(REQUIRED_FOR_TRAFFIC.storage).toBe(false);
      expect(REQUIRED_FOR_TRAFFIC.sms).toBe(false);
    });
  });
});
