import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { NotFoundOrNotYoursException, ResolveOwner } from '@beauclick/ownership';

import { BookingService } from './booking.service';
import { BookingPartyResolver, BookingProfessionalResolver } from './booking-party.resolver';
import { BookingEntity } from '../entities/booking.entity';
import { BookingHistoryEntity } from '../entities/booking-history.entity';
import { CancelBookingDto, RescheduleBookingDto } from '../dto/booking.dto';
import { PROFESSIONAL_DIRECTORY, ProfessionalDirectory } from '../ports';

export function toBookingShape(booking: BookingEntity) {
  return {
    id: booking.id,
    customerId: booking.customerId,
    professionalId: booking.professionalId,
    serviceId: booking.serviceId,
    slotId: booking.slotId,
    startAt: booking.slotStart.toISOString(),
    endAt: booking.slotEnd.toISOString(),
    status: booking.status,
    holdExpiresAt: booking.holdExpiresAt?.toISOString() ?? null,
    rescheduleCount: booking.rescheduleCount,
    cancellationReason: booking.cancellationReason,
    createdAt: booking.createdAt.toISOString(),
  };
}

function toHistoryShape(row: BookingHistoryEntity) {
  return {
    id: row.id,
    event: row.event,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    actorType: row.actorType,
    reason: row.reason,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Booking reads and lifecycle transitions.
 *
 * Creation lives elsewhere on purpose: `POST /v1/bookings` has to create a
 * booking AND its order in one transaction, which spans two modules and is
 * therefore owned by the composition root (`apps/api`'s CheckoutController).
 * Splitting the resource across two controllers is the honest consequence
 * of the module boundary -- the alternative would be booking-service
 * importing commerce-service, which ADR-011 forbids for good reason.
 */
@Controller('v1')
export class BookingController {
  constructor(
    private readonly bookings: BookingService,
    private readonly party: BookingPartyResolver,
    @Inject(PROFESSIONAL_DIRECTORY) private readonly directory: ProfessionalDirectory,
  ) {}

  @Get('me/bookings')
  async myBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<PaginatedResult<ReturnType<typeof toBookingShape>[]>> {
    const { items, total } = await this.bookings.listForCustomer(user.userId, query.page, query.limit);
    return { value: items.map(toBookingShape), meta: { pagination: { page: query.page, limit: query.limit, total } } };
  }

  @Get('me/professional-bookings')
  async myProfessionalBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<PaginatedResult<ReturnType<typeof toBookingShape>[]>> {
    const professionalId = await this.directory.professionalIdForOwner(user.userId);
    if (!professionalId) throw new NotFoundOrNotYoursException();
    const { items, total } = await this.bookings.listForProfessional(professionalId, query.page, query.limit);
    return { value: items.map(toBookingShape), meta: { pagination: { page: query.page, limit: query.limit, total } } };
  }

  @ResolveOwner(BookingPartyResolver)
  @Get('bookings/:id')
  async getOne(@Param('id') id: string) {
    const booking = await this.bookings.findById(id);
    if (!booking) throw new NotFoundOrNotYoursException();
    return toBookingShape(booking);
  }

  @ResolveOwner(BookingPartyResolver)
  @Get('bookings/:id/history')
  async history(@Param('id') id: string) {
    return (await this.bookings.historyFor(id)).map(toHistoryShape);
  }

  /**
   * Either party may cancel. The actor type recorded on the booking is
   * re-derived here from the session, never taken from the request -- a
   * customer cannot record their cancellation as the professional's.
   *
   * This is the second, independent ownership check: `OwnershipGuard` has
   * already run the same resolver at the HTTP boundary. Re-resolving at the
   * point of use is the defense-in-depth pattern GAP-05 established, applied
   * from day one rather than after an audit.
   */
  @ResolveOwner(BookingPartyResolver)
  @Post('bookings/:id/cancel')
  async cancel(@Param('id') id: string, @Body() dto: CancelBookingDto, @CurrentUser() user: AuthenticatedUser) {
    const role = await this.party.roleFor(id, user.userId);
    if (!role) throw new NotFoundOrNotYoursException();

    await this.bookings.cancel(id, { type: role, id: user.userId }, dto.reason ?? null);
    const booking = await this.bookings.findById(id);
    if (!booking) throw new NotFoundOrNotYoursException();
    return toBookingShape(booking);
  }

  @ResolveOwner(BookingPartyResolver)
  @Post('bookings/:id/reschedule')
  async reschedule(@Param('id') id: string, @Body() dto: RescheduleBookingDto, @CurrentUser() user: AuthenticatedUser) {
    const role = await this.party.roleFor(id, user.userId);
    if (!role) throw new NotFoundOrNotYoursException();

    const booking = await this.bookings.reschedule(id, dto.newSlotId, { type: role, id: user.userId }, dto.reason ?? null);
    return toBookingShape(booking);
  }

  @ResolveOwner(BookingProfessionalResolver)
  @Post('bookings/:id/complete')
  async complete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.bookings.complete(id, { type: 'professional', id: user.userId });
    const booking = await this.bookings.findById(id);
    if (!booking) throw new NotFoundOrNotYoursException();
    return toBookingShape(booking);
  }

  @ResolveOwner(BookingProfessionalResolver)
  @Post('bookings/:id/no-show')
  async noShow(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    await this.bookings.markNoShow(id, { type: 'professional', id: user.userId });
    const booking = await this.bookings.findById(id);
    if (!booking) throw new NotFoundOrNotYoursException();
    return toBookingShape(booking);
  }
}
