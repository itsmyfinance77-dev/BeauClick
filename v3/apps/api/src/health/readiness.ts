/**
 * The readiness vocabulary (V3.1 Phase F).
 *
 * ## Why "healthy" was not enough
 *
 * `/health` answered one question -- is the database reachable -- and reported
 * the storage driver alongside it. That is a liveness check, and it is the
 * right shape for one: an orchestrator asking "should I restart this process?"
 * wants a fast, boolean-ish answer.
 *
 * It cannot answer the question this phase actually needs answered, which is
 * not about health at all:
 *
 *   **Is this deployment talking to real things, or to stand-ins?**
 *
 * Every stand-in in this platform is deliberate, tested, and correct for the
 * environment it was built for -- the sandbox gateway, the in-memory search
 * engine, the local disk storage driver, the null SMS provider. Each is also
 * indistinguishable from the real thing in a health check that reports only
 * `ok`. A deployment running four stand-ins is perfectly HEALTHY. It is also
 * not a marketplace: nobody can log in, nothing can be searched, no money can
 * move, and every uploaded file disappears with the container.
 *
 * V2 shipped a "local development only" payment stand-in whose status was a
 * sentence in the UI with no mechanism behind it, and a readiness audit found
 * it still reachable. `NotificationChannelPort.providerVerified` and
 * `MediaService.describeDriver()` are this codebase's existing answers to that
 * lesson, one dependency at a time. This generalises them.
 *
 * ## The four distinctions, and why each earns a separate word
 *
 * `not_configured` — nothing is set. The dependency is off. Honest and often
 * correct (SMS on a developer's laptop).
 *
 * `simulated` — a local stand-in is serving. **This is the one that matters.**
 * It is not an error and must not be reported as one; it is the fact that a
 * green check does not mean what a reader assumes.
 *
 * `configured` — real settings are present, but nothing was probed on this
 * request. Deliberately distinct from `reachable`: object storage and a
 * payment gateway must not be probed on every liveness poll, so claiming they
 * are reachable would be claiming something nobody checked.
 *
 * `reachable` / `unreachable` — probed on THIS request and answered, or did
 * not. Only used where a probe is cheap enough to actually run.
 *
 * ## Why `productionVerified` is a separate axis
 *
 * A dependency can be configured, reachable, and still never have been
 * exercised against the real external service under production conditions.
 * `reachable` says a socket opened; it says nothing about whether one real OTP
 * has ever arrived on a real phone, or one real rial has ever settled.
 *
 * That distinction is the whole of the External Enablement Gate, so it is
 * modelled explicitly rather than left to a reader's inference -- and it is
 * sourced from `EXTERNAL_VERIFICATION_LEDGER` below, which names the exact
 * open gap for each. **No probe can set it true.** It becomes true when the
 * gate is executed and the ledger is edited, which is a deliberate act by a
 * person holding evidence, not a side effect of a socket connecting.
 */

export const READINESS_STATES = ['not_configured', 'simulated', 'configured', 'reachable', 'unreachable'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const DEPENDENCIES = [
  'database',
  'ledger',
  'search',
  'storage',
  'payment',
  'sms',
  'error_reporting',
  'throttle_store',
  // V3.2-A. The AI assistant's provider (ADR-029 §4). Present in this
  // vocabulary from the first day the domain exists, rather than added later
  // when a vendor is chosen -- the whole point is that a deployment serving the
  // deterministic local assistant must be reportable as `simulated` BEFORE
  // anybody can mistake it for something else.
  'ai_provider',
] as const;
export type DependencyName = (typeof DEPENDENCIES)[number];

export interface DependencyReadiness {
  name: DependencyName;
  state: ReadinessState;
  /**
   * Whether this dependency has been verified against the real external
   * service under production conditions. Always sourced from
   * `EXTERNAL_VERIFICATION_LEDGER`; never inferred from a probe.
   */
  productionVerified: boolean;
  /**
   * The open gap that keeps `productionVerified` false, so a reader of this
   * output can go straight to the reconciliation document. Null once verified.
   */
  blockedBy: string | null;
  /**
   * Whether this dependency being un-ready should stop traffic being routed
   * here. Distinct from `state`: a `simulated` SMS provider is a launch
   * blocker but not a reason to pull a running instance out of rotation.
   */
  required: boolean;
}

/**
 * The external-verification ledger.
 *
 * One row per dependency whose production behaviour cannot be established
 * from inside this repository. `verified: false` with a named gap is the
 * honest state; flipping one to `true` is an assertion that the evidence named
 * in `V3.1_EXTERNAL_ENABLEMENT_STRATEGY.md` §4 has actually been produced.
 *
 * It lives in code rather than a document for one reason: the readiness
 * endpoint has to serve it, and a status that is maintained in prose drifts
 * from the deployment it describes within one release.
 *
 * **Nothing in this codebase may set a value here to `true`.** Not a probe,
 * not a configuration check, not a successful sandbox run. Each is a person's
 * statement that a live check was performed.
 */
export interface ExternalVerification {
  /** True only when the real live check named in `evidence` has been performed. */
  readonly verified: boolean;
  /** The gap id in `V3.1_GAP_RECONCILIATION.md`, or null once verified. */
  readonly gap: string | null;
  /** What would have to be true to flip `verified`. */
  readonly evidence: string;
}

export const EXTERNAL_VERIFICATION_LEDGER: Readonly<Record<DependencyName, ExternalVerification>> = {
  database: {
    verified: false,
    gap: 'HOSTING_GRANTS',
    evidence: 'database/scripts/verify-roles.ts passing against the real target host, not a CI container.',
  },
  ledger: {
    verified: false,
    gap: 'HOSTING_GRANTS',
    evidence: 'The append-only role contract proven on the real target host with financial-roles.sql applied.',
  },
  search: {
    verified: false,
    gap: 'HOSTING',
    evidence: 'A managed OpenSearch cluster in the selected region serving real queries.',
  },
  storage: {
    verified: false,
    gap: 'HOSTING',
    evidence: 'An Iran-reachable S3-compatible bucket holding real uploads, with its retention verified.',
  },
  payment: {
    verified: false,
    gap: 'GAP-06b',
    evidence:
      'A selected gateway adapter, merchant credentials, a full lifecycle against the gateway own sandbox, and one controlled real-money transaction.',
  },
  sms: {
    verified: false,
    gap: 'GAP-11',
    evidence: 'One real OTP delivered to a real phone through the selected production path.',
  },
  error_reporting: {
    verified: false,
    gap: 'OPS-04',
    evidence: 'A real production error received by the selected error-tracking backend.',
  },
  throttle_store: {
    verified: false,
    gap: 'THROTTLE-STORE',
    evidence:
      'Only applicable if the deployment topology is multi-instance. Single-instance in-memory throttling is correct and needs no external verification; a shared store must be verified if and only if more than one API instance runs.',
  },
  ai_provider: {
    verified: false,
    gap: 'AI-PROVIDER',
    evidence:
      'A selected AI vendor, credentials, proven reachability from the hosting region, an agreed pricing model, and an approved platform-wide monetary spend ceiling (V32-DEC-008) -- which is itself still open, and without which a real provider must not be enabled. The deterministic local assistant shipped in V3.2-A is NOT a real AI provider and cannot advance this row.',
  },
} as const;

/**
 * Which dependencies must be ready for this instance to serve traffic.
 *
 * Deliberately NOT everything. An orchestrator uses readiness to decide
 * routing, and a readiness probe that fails because SMS has no vendor would
 * take every instance out of rotation for a condition no restart can fix --
 * turning a known, recorded, non-urgent gap into a total outage. The rule is:
 * a dependency is `required` when serving a request WITHOUT it produces a
 * wrong answer rather than a reduced one.
 */
export const REQUIRED_FOR_TRAFFIC: Readonly<Record<DependencyName, boolean>> = {
  // Nothing works without these two, and both are same-cluster.
  database: true,
  ledger: true,
  // Search degrades to a visibly reduced result page (SearchService already
  // has that path). A degraded page beats no page.
  search: false,
  // An upload fails; browsing does not.
  storage: false,
  // Checkout fails; the rest of the marketplace works. Pulling every instance
  // because a gateway is down would also remove the pages that TELL customers
  // it is down.
  payment: false,
  sms: false,
  // Errors are still logged when the reporter transmits nothing. Losing the
  // dashboard is not a reason to stop serving customers.
  error_reporting: false,
  throttle_store: false,
  // An unavailable assistant must never take an instance out of rotation. Every
  // other surface in the marketplace works without it, and pulling instances
  // because a provider is down would also remove the pages that tell customers
  // it is down -- the same reasoning `payment` records one line up.
  ai_provider: false,
} as const;

/**
 * The overall verdict.
 *
 * `ready` gates traffic. It answers only the routing question and deliberately
 * says nothing about production-readiness -- an instance can be `ready` while
 * every external verification is still open, and it usually will be.
 */
export function overallReadiness(dependencies: readonly DependencyReadiness[]): 'ready' | 'not_ready' {
  const blocking = dependencies.filter((d) => d.required && (d.state === 'unreachable' || d.state === 'not_configured'));
  return blocking.length === 0 ? 'ready' : 'not_ready';
}

/** True when every dependency has a real, non-simulated implementation behind it. */
export function allDependenciesReal(dependencies: readonly DependencyReadiness[]): boolean {
  return dependencies.every((d) => d.state !== 'simulated' && d.state !== 'not_configured');
}

/** True only when every external verification in the ledger has actually been performed. */
export function externalEnablementComplete(): boolean {
  return Object.values(EXTERNAL_VERIFICATION_LEDGER).every((entry) => entry.verified);
}

export interface ConfigurationVerdict {
  valid: boolean;
  /** Present ONLY outside production. See below. */
  problems?: string[];
}

/**
 * Decides how much of the configuration verdict this endpoint may publish.
 *
 * The problem messages are not secret-bearing -- `env.validation.spec.ts`
 * asserts that no rule ever echoes a secret VALUE, and reports a length where
 * a value would be. They are, however, a configuration MAP: they name the
 * CORS origins, the storage driver, the payment environment, and which
 * variables are unset. On a public, unauthenticated, rate-limit-exempt
 * endpoint that is a free inventory of what a deployment is running and what
 * it is missing.
 *
 * So production gets the verdict and nothing else, and every other environment
 * gets the reasons -- which is where they are actually useful and where there
 * is nothing to protect.
 *
 * A pure function, and separate from the service, so this branch can be
 * asserted without booting a process as production -- which is not possible
 * anyway, because `validateEnv` and `MediaModule` would both refuse the test
 * configuration, exactly as they should.
 */
export function configurationVerdict(isProduction: boolean, problems: readonly string[]): ConfigurationVerdict {
  return isProduction ? { valid: problems.length === 0 } : { valid: problems.length === 0, problems: [...problems] };
}
