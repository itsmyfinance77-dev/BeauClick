import { INestApplication, Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { CAPABILITY_KEY, PRIVILEGED_CAPABILITIES } from '@beauclick/auth';
import { AUDIT_ACTION_KEY, AUDIT_EXEMPT_KEY, AuditActionMetadata } from './audit-action.decorator';

/**
 * Boot-time structural enforcement: a privileged MUTATION that declares
 * neither `@AuditAction` nor `@AuditExempt` prevents the application from
 * starting.
 *
 * WHY THIS EXISTS AS A BOOT ASSERTION rather than a review checklist.
 *
 * V2 found the same bug three separate times across two plugins: a
 * REST-reachable, capability-gated admin mutation that skipped the audit call
 * its wp-admin twin made (GAP-02). Two were fixed individually; the third was
 * still open at v2.3.0. What finally closed the CLASS was a boot-time
 * route-registration check that made an unaudited admin mutation impossible to
 * register -- and that is the pattern reused here, deliberately, rather than
 * invented afresh.
 *
 * V3 arrives at the same risk from the opposite direction. Until Phase A no
 * account could hold `bc_manage_platform` at all, so the five pre-existing
 * admin mutations had never been reachable by anyone. Phase A creates the first
 * privileged principal, so the enforcement lands in the SAME phase as the thing
 * it protects against rather than after it.
 *
 * HOW IT READS THE ROUTES: `DiscoveryService` + `MetadataScanner`, Nest's own
 * supported API, over the controllers Nest actually instantiated. An earlier
 * draft walked Express's `_router.stack` and read metadata off the bound
 * callback; that is private framework internals, and worse, when it fails it
 * fails by finding NOTHING -- a check that silently passes is more dangerous
 * than no check, because it reads as a guarantee. The spec therefore asserts a
 * known-audited route IS seen, not merely that the offender list is empty.
 *
 * WHAT DOES NOT COUNT: reads. A GET listing settlements changes nothing, and
 * auditing every read would bury the mutations in noise. A deliberate boundary,
 * stated rather than assumed.
 */

/**
 * Re-exported, NOT redefined.
 *
 * The live-revocation re-check in `CapabilityGuard` and this assertion must
 * agree about which capabilities are privileged -- they are the same concept.
 * Two lists that must agree are one list waiting to disagree, so there is
 * exactly one, in `libs/auth`.
 */
export { PRIVILEGED_CAPABILITIES };

const MUTATING_METHODS = new Set<RequestMethod>([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

export interface PrivilegedRoute {
  controller: string;
  handler: string;
  capability: string;
  auditAction: string | null;
  /** False only where a route has DECLARED it cannot commit its record atomically, with a reason. */
  transactional: boolean | null;
  auditExempt: string | null;
}

@Injectable()
export class AuditEnforcementService {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
  ) {}

  /**
   * Every privileged mutation Nest has registered, with its declared audit
   * intent.
   *
   * Returned in full rather than filtered to offenders so a test can prove the
   * scanner sees real routes -- the property that makes an empty offender list
   * mean something.
   */
  privilegedMutations(): PrivilegedRoute[] {
    const found: PrivilegedRoute[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const prototype = Object.getPrototypeOf(instance);

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== 'function') continue;

        const httpMethod: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
        if (httpMethod === undefined) continue; // not a route handler
        if (!MUTATING_METHODS.has(httpMethod)) continue;

        // Capability metadata is read from the SAME place `CapabilityGuard`
        // reads it, so this cannot drift from the real guard. There is no
        // second inventory of admin routes to keep in sync -- which would be
        // the original bug one level up.
        const capability: string | undefined = Reflect.getMetadata(CAPABILITY_KEY, handler);
        if (!capability || !PRIVILEGED_CAPABILITIES.includes(capability)) continue;

        const declared: AuditActionMetadata | undefined = Reflect.getMetadata(AUDIT_ACTION_KEY, handler);
        found.push({
          controller: metatype.name,
          handler: `${metatype.name}.${methodName}`,
          capability,
          auditAction: declared?.action ?? null,
          transactional: declared ? declared.transactional : null,
          auditExempt: Reflect.getMetadata(AUDIT_EXEMPT_KEY, handler) ?? null,
        });
      }
    }

    return found;
  }

  /** The privileged mutations declaring no audit intent. Empty is the passing state. */
  unaudited(): PrivilegedRoute[] {
    return this.privilegedMutations().filter((r) => !r.auditAction && !r.auditExempt);
  }
}

/**
 * The assertion. Called from `main.ts` after the application is initialised and
 * from the test app factory, so a violation fails the suite as well as the boot.
 */
export function assertPrivilegedMutationsAreAudited(app: INestApplication): void {
  const service = app.get(AuditEnforcementService, { strict: false });
  const offenders = service.unaudited();
  if (offenders.length === 0) return;

  const detail = offenders.map((o) => `  ${o.handler}  (${o.capability})`).join('\n');
  throw new Error(
    'Privileged mutation(s) registered without an audit declaration.\n' +
      'Every capability-gated mutation must carry @AuditAction(...) and write the\n' +
      'record, or @AuditExempt(<reason>) stating why it deliberately does not.\n' +
      "This is GAP-02's bug class, which V2 hit three times before making it\n" +
      'structural. See libs/audit/src/audit-enforcement.ts.\n\n' +
      detail,
  );
}
