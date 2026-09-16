import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * `POST /api/v1/bookings/:id/remedy` — V3.3 #161 (`#42d`), ADR-051 §8.
 *
 * `newSlotId` is required only when `choice === 'reschedule'`, checked by
 * the resolution service rather than a conditional validator here -- the
 * same choice `RescheduleBookingDto` makes for `newSlotId` being unconditionally
 * required on a route where it always applies. No price, no consequence
 * acceptance and no reason: this move is never a customer-initiated
 * reschedule, so none of `RescheduleBookingDto`'s other fields apply to it.
 */
export class RemedyChoiceDto {
  @IsIn(['refund', 'reschedule'])
  choice!: 'refund' | 'reschedule';

  @IsOptional()
  @IsUUID()
  newSlotId?: string;
}
