import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BOOKING_RESOURCE_ASSIGNMENT_STATUSES,
  BookingResourceAssignmentEntity,
} from '../entities/booking-resource-assignment.entity';
import { ELIGIBLE_RESOURCE_DIRECTORY, RESOURCE_ASSIGNMENT_LOCK_NAMESPACE } from '../ports';
import { getMetadataArgsStorage } from 'typeorm';

/**
 * V3.3 Story #128 (`#110b`) -- the closed contract, pinned.
 *
 * The transactional, concurrency, constraint and closure-blocking behaviour
 * lives in `apps/api/test/booking-resource-assignments.pg-spec.ts` -- it
 * needs a real server (ADR-049 §2.4). This file checks the shapes a real
 * server cannot: the lifecycle vocabulary, the entity's exact columns, and
 * that `BookingService`'s own source follows the lock-before-write and
 * two-read protocol its documentation claims, so a future edit that quietly
 * drops the lock or the re-read fails a fast test rather than only
 * revealing itself under real concurrency.
 */
describe('booking resource assignment contract (#128 / #110b)', () => {
  describe('the lifecycle vocabulary', () => {
    it('is EXACTLY active | released', () => {
      expect([...BOOKING_RESOURCE_ASSIGNMENT_STATUSES]).toEqual(['active', 'released']);
    });

    it('has no retired/cancelled/expired synonym -- the booking itself already records why', () => {
      for (const forbidden of ['retired', 'cancelled', 'expired', 'pending', 'confirmed', 'busy', 'free']) {
        expect(BOOKING_RESOURCE_ASSIGNMENT_STATUSES as readonly string[]).not.toContain(forbidden);
      }
    });
  });

  describe('the entity', () => {
    it('declares exactly the ratified columns -- no kind, no occupancy, no reference field', () => {
      const columns = getMetadataArgsStorage()
        .filterColumns(BookingResourceAssignmentEntity)
        .map((c) => c.propertyName)
        .sort();
      expect(columns).toEqual(['bookingId', 'createdAt', 'endAt', 'id', 'resourceId', 'startAt', 'status', 'updatedAt']);
      for (const forbidden of ['kind', 'resourceRef', 'occupancy', 'businessId', 'locationId', 'customerId', 'released_at']) {
        expect(columns).not.toContain(forbidden);
      }
    });

    it('is named booking_resource_assignments', () => {
      const table = getMetadataArgsStorage().tables.find((t) => t.target === BookingResourceAssignmentEntity);
      expect(table?.name).toBe('booking_resource_assignments');
    });
  });

  describe('the advisory-lock namespace', () => {
    it('is distinct from #131\'s (\'srrq\') and wishlist\'s (\'wish\')', () => {
      expect(RESOURCE_ASSIGNMENT_LOCK_NAMESPACE).not.toBe(0x73_72_72_71);
      expect(RESOURCE_ASSIGNMENT_LOCK_NAMESPACE).not.toBe(0x77_69_73_68);
    });
  });

  describe('ELIGIBLE_RESOURCE_DIRECTORY is a distinct token', () => {
    it('is a symbol naming itself', () => {
      expect(typeof ELIGIBLE_RESOURCE_DIRECTORY).toBe('symbol');
      expect(ELIGIBLE_RESOURCE_DIRECTORY.toString()).toContain('ELIGIBLE_RESOURCE_DIRECTORY');
    });
  });

  describe('BookingService source follows its own documented protocol', () => {
    const code = readFileSync(join(__dirname, 'booking.service.ts'), 'utf8');

    it('locks each candidate BEFORE re-checking it authoritatively, inside the same loop', () => {
      const lockIndex = code.indexOf('for (const resourceId of sortedCandidateIds)');
      const lockCallIndex = code.indexOf('await lockResourceForAssignment(manager, resourceId)');
      const rereadIndex = code.indexOf('const authoritative = await this.eligibleResources.eligibleResourcesFor');
      expect(lockIndex).toBeGreaterThan(-1);
      expect(lockCallIndex).toBeGreaterThan(lockIndex);
      expect(rereadIndex).toBeGreaterThan(lockCallIndex);
    });

    it('calls eligibleResourcesFor at least twice inside syncResourceAssignment -- once unlocked, once per candidate locked', () => {
      const start = code.indexOf('private async syncResourceAssignment');
      const end = code.indexOf('private async releaseResourceAssignment');
      const body = code.slice(start, end);
      expect((body.match(/this\.eligibleResources\.eligibleResourcesFor\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });

    it('never locks a candidate it never re-checks or attempts -- no upfront lock-them-all loop', () => {
      const start = code.indexOf('private async syncResourceAssignment');
      const end = code.indexOf('private async releaseResourceAssignment');
      const body = code.slice(start, end);
      expect((body.match(/lockResourceForAssignment\(/g) ?? []).length).toBe(1);
    });

    it('wraps each candidate attempt in its own SAVEPOINT, so a collision never aborts the surrounding transaction', () => {
      const start = code.indexOf('private async syncResourceAssignment');
      const end = code.indexOf('private async releaseResourceAssignment');
      const body = code.slice(start, end);
      expect(body).toContain("manager.query('SAVEPOINT sp_resource_assignment')");
      expect(body).toContain("manager.query('RELEASE SAVEPOINT sp_resource_assignment')");
      expect(body).toContain("manager.query('ROLLBACK TO SAVEPOINT sp_resource_assignment')");
    });

    it('catches a resource collision and never lets it escape as an unmapped 500', () => {
      expect(code).toContain('isResourceCollision(err)');
      expect(code).toMatch(/23P01/);
    });

    it('never selects with an unlocked ORDER BY ... LIMIT 1', () => {
      const start = code.indexOf('private async syncResourceAssignment');
      const end = code.indexOf('private async releaseResourceAssignment');
      const body = code.slice(start, end);
      expect(body).not.toMatch(/LIMIT\s+1/i);
    });

    it('resolves the resource inside the SAME transaction as the slot claim -- called with the caller\'s manager, never a fresh one', () => {
      expect(code).not.toMatch(/syncResourceAssignment\(\s*this\.dataSource\.manager/);
      expect(code).toMatch(/await this\.syncResourceAssignment\(m(?:anager)?,/);
    });

    it('cancel() releases the resource assignment in the same transaction as releaseSlot', () => {
      const cancelStart = code.indexOf('async cancel(');
      const cancelEnd = code.indexOf('async complete(');
      const body = code.slice(cancelStart, cancelEnd);
      expect(body).toContain('releaseResourceAssignment');
      // releaseSlot must appear BEFORE releaseResourceAssignment is called in source order --
      // both still commit or roll back together either way, but this pins the documented order.
      expect(body.indexOf('this.releaseSlot(')).toBeLessThan(body.indexOf('this.releaseResourceAssignment('));
    });

    it('reschedule() re-evaluates the resource for the DESTINATION slot, never carrying the old one forward', () => {
      const rescheduleStart = code.indexOf('async reschedule(');
      const rescheduleEnd = code.indexOf('// ---------------------------------------------------------------------\n  // Hold expiry sweep');
      const body = code.slice(rescheduleStart, rescheduleEnd);
      expect(body).toContain('syncResourceAssignment(m, bookingId, booking.serviceId, claimed.deliveryLocationId, claimed.startAt, claimed.endAt)');
    });
  });
});
