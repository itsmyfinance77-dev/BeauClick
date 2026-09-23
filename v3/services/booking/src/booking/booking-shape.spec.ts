import { BookingEntity } from '../entities/booking.entity';
import { toBookingShape, toProfessionalBookingShape } from './booking.controller';

function booking(): BookingEntity {
  return Object.assign(new BookingEntity(), {
    id: '11111111-1111-4111-8111-111111111111',
    customerId: '22222222-2222-4222-8222-222222222222',
    professionalId: '33333333-3333-4333-8333-333333333333',
    serviceId: null,
    slotId: '44444444-4444-4444-8444-444444444444',
    slotStart: new Date('2026-09-22T08:00:00.000Z'),
    slotEnd: new Date('2026-09-22T09:00:00.000Z'),
    status: 'confirmed',
    holdExpiresAt: null,
    rescheduleCount: 0,
    cancellationReason: null,
    createdAt: new Date('2026-09-20T08:00:00.000Z'),
  });
}

describe('booking response shapes', () => {
  it('adds the customer display name only to the professional shape', () => {
    expect(toProfessionalBookingShape(booking(), 'مریم احمدی')).toMatchObject({
      customerDisplayName: 'مریم احمدی',
    });
    expect(toBookingShape(booking())).not.toHaveProperty('customerDisplayName');
  });

  it('represents an absent display name as null', () => {
    expect(toProfessionalBookingShape(booking(), null)).toHaveProperty('customerDisplayName', null);
  });
});
