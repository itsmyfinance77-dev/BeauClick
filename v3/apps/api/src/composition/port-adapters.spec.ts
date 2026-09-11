import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * V3.3 Story #128 (`#110b`) -- closing a disclosed verification gap.
 *
 * `BookingBackedResourceAssignmentDirectory.hasFutureAssignment` and
 * `booking`'s own `syncResourceAssignment` (pinned by
 * `booking-resource-assignment.contract.spec.ts` in `services/booking`) take
 * the SAME advisory lock, keyed identically, so that whichever side reaches a
 * given resource id first is strictly ordered ahead of the other -- see
 * `RESOURCE_ASSIGNMENT_DIRECTORY`'s own documentation
 * (`services/booking/src/ports.ts`). That guarantee depends entirely on both
 * sides taking the lock AND doing their read through the SAME transactional
 * `EntityManager` the caller (`LocationResourceService.retire` /
 * `BusinessLocationService.transition`) is already inside -- a lock taken on
 * a different connection is released the instant that single statement
 * returns, providing no mutual exclusion at all for the check-then-act
 * sequence that follows it.
 *
 * A literal mutation probe (routing the lock and the read through
 * `this.dataSource.manager` instead of the caller's `manager`) proved this
 * property is NOT reliably caught by the real-PostgreSQL retirement-race test
 * (`booking-resource-assignments.pg-spec.ts` §8) -- that test only asserts
 * the two outcomes are mutually exclusive, which a narrow race window can
 * still satisfy by luck even with no effective lock held. This fast,
 * deterministic structural check closes that gap the same way
 * `booking-resource-assignment.contract.spec.ts` already does for
 * `syncResourceAssignment`: by pinning the SOURCE, so a future edit that
 * quietly swaps in a fresh connection fails immediately, not only under load.
 */
describe('BookingBackedResourceAssignmentDirectory follows its own documented locking protocol', () => {
  const code = readFileSync(join(__dirname, 'port-adapters.ts'), 'utf8');

  function hasFutureAssignmentBody(): string {
    const start = code.indexOf('class BookingBackedResourceAssignmentDirectory');
    if (start === -1) throw new Error('BookingBackedResourceAssignmentDirectory not found in port-adapters.ts');
    const methodStart = code.indexOf('async hasFutureAssignment(', start);
    const methodEnd = code.indexOf('\n}', methodStart);
    return code.slice(methodStart, methodEnd);
  }

  it('locks each resource id using the CALLER-SUPPLIED manager, never a fresh connection', () => {
    const body = hasFutureAssignmentBody();
    expect(body).toContain('await lockResourceForAssignment(manager, id)');
    expect(body).not.toMatch(/lockResourceForAssignment\(\s*this\.dataSource/);
  });

  it('reads booking_resource_assignments through the SAME caller-supplied manager', () => {
    const body = hasFutureAssignmentBody();
    expect(body).toMatch(/await manager\.query\(/);
    expect(body).not.toMatch(/this\.dataSource\.manager\.query\(/);
  });
});
