import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * `active` occupies the resource for its `[start_at, end_at)` range;
 * `released` no longer does but the row survives as history. There is no
 * `retired`/`cancelled` distinction -- WHY the assignment stopped applying is
 * already recorded on the booking itself (`status`, `cancellationReason`,
 * `booking_history`); this column only answers whether the resource is
 * currently held.
 */
export const BOOKING_RESOURCE_ASSIGNMENT_STATUSES = ['active', 'released'] as const;
export type BookingResourceAssignmentStatus = (typeof BOOKING_RESOURCE_ASSIGNMENT_STATUSES)[number];

/**
 * One booking's occupancy of one resource -- V3.3 Story #128 (`#110b`), bound
 * by `V33-DEC-034` R4/R7 and ADR-049 §6.
 *
 * ## The only booking-schema table this story adds
 *
 * Joins an opaque resource id to a booking's time range. `booking.bookings`
 * and `booking.availability_slots` gain no column. See the migration
 * (`20260916100001_create_booking_resource_assignments.sql`) for the full
 * reasoning behind the schema shape.
 *
 * ## `resourceId` is OPAQUE
 *
 * References `business.location_resources.id`. **No cross-schema foreign key
 * by convention** and no `business` ORM import anywhere in `booking` --
 * candidates arrive through `#131`'s `ELIGIBLE_RESOURCE_DIRECTORY` port, and
 * closure/retirement blocking is answered through this story's own
 * `RESOURCE_ASSIGNMENT_DIRECTORY` port in the opposite direction.
 *
 * ## One row per booking, mutated across reschedule -- not appended
 *
 * `UNIQUE(booking_id)` is a genuine, non-partial constraint: there is at most
 * one assignment row per booking, ever. A reschedule to a slot needing a
 * different (or no) resource UPDATEs this same row; it never inserts a
 * second one for the same booking. `status` distinguishes "currently
 * occupying" (`active`) from "no longer does, but the row survives as
 * history" (`released`) -- exactly the discipline `booking.bookings` itself
 * follows across reschedule (one row, mutated, with `booking_history`
 * carrying the change trail).
 *
 * ## No occupancy, kind or reference field
 *
 * Nothing here is ever returned over HTTP. `V33-DEC-034` R6/R9: a customer
 * must not be able to infer which resources a seller owns, a resource's
 * identity or kind, or whether a refusal was caused by a busy, foreign,
 * closed or wrong-kind resource.
 */
@Entity({ name: 'booking_resource_assignments', schema: 'booking' })
@Index('uq_booking_resource_assignments_booking', ['bookingId'], { unique: true })
export class BookingResourceAssignmentEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References booking.bookings.id -- a real, same-schema FK. */
  @Column({ type: 'uuid' })
  bookingId!: string;

  /** References business.location_resources.id. No cross-schema FK by convention -- opaque, arriving through a port. */
  @Column({ type: 'uuid' })
  resourceId!: string;

  /** Denormalized from the booking's own slotStart/slotEnd at assignment time, exactly as booking.bookings denormalizes them from the slot. */
  @Column({ type: 'timestamptz' })
  startAt!: Date;

  @Column({ type: 'timestamptz' })
  endAt!: Date;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: BookingResourceAssignmentStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
