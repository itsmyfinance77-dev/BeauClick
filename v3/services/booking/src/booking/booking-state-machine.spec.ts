import { BOOKING_STATUSES, BookingStatus, SLOT_HOLDING_STATUSES } from '../entities/booking.entity';
import { LEGAL_TRANSITIONS } from './booking.service';
import { SLOT_STATUSES } from '../entities/availability-slot.entity';

/**
 * The booking state machine as a declared table, checked for the properties
 * a state machine must have rather than merely spot-checked.
 *
 * Worth asserting structurally because the table is consulted at RUNTIME by
 * `transition()`: a typo here would not fail to compile, it would silently
 * permit or forbid a real transition.
 */
describe('booking state machine', () => {
  it('declares a transition list for every status, with no orphans', () => {
    expect(Object.keys(LEGAL_TRANSITIONS).sort()).toEqual([...BOOKING_STATUSES].sort());
  });

  it('never points at a status that does not exist, and has no self-transitions', () => {
    for (const [from, targets] of Object.entries(LEGAL_TRANSITIONS)) {
      for (const to of targets) {
        expect(BOOKING_STATUSES).toContain(to);
        expect(to).not.toBe(from);
      }
    }
  });

  it('makes completed, cancelled, expired and no_show terminal', () => {
    for (const terminal of ['completed', 'cancelled', 'expired', 'no_show'] as BookingStatus[]) {
      expect(LEGAL_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  it('allows a pending booking to confirm, cancel, or expire -- and nothing else', () => {
    expect([...LEGAL_TRANSITIONS.pending].sort()).toEqual(['cancelled', 'confirmed', 'expired']);
  });

  it('allows a confirmed booking to complete, cancel, or become a no-show -- and nothing else', () => {
    expect([...LEGAL_TRANSITIONS.confirmed].sort()).toEqual(['cancelled', 'completed', 'no_show']);
  });

  it('never allows a booking to go backwards from confirmed to pending', () => {
    expect(LEGAL_TRANSITIONS.confirmed).not.toContain('pending');
  });

  it('treats expired as a state distinct from cancelled', () => {
    // V2 modelled an abandoned hold as cancelled with reason='expired', which
    // made "did a customer actually cancel on us?" unanswerable without
    // string-matching a free-text column -- and made the refund decision
    // depend on that same string.
    expect(BOOKING_STATUSES).toContain('expired');
    expect(BOOKING_STATUSES).toContain('cancelled');
  });

  it('counts exactly pending and confirmed as slot-holding', () => {
    // This list mirrors the partial unique index on slot_id. If it drifted
    // from the migration, a terminal booking would start blocking its slot.
    expect([...SLOT_HOLDING_STATUSES].sort()).toEqual(['confirmed', 'pending']);
  });

  it('makes every state reachable from the initial state', () => {
    const reachable = new Set<BookingStatus>(['pending']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const status of [...reachable]) {
        for (const next of LEGAL_TRANSITIONS[status]) {
          if (!reachable.has(next)) {
            reachable.add(next);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...BOOKING_STATUSES].sort());
  });
});

describe('slot state machine', () => {
  it('has exactly three states -- "no row" already means "not offered"', () => {
    expect([...SLOT_STATUSES]).toEqual(['open', 'held', 'booked']);
  });
});
