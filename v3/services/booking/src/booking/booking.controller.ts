import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser, PageQueryDto, PaginatedResult } from '@beauclick/http';
import { NotFoundOrNotYoursException, ResolveOwner } from '@beauclick/ownership';

import { BookingNoShowState, BookingService } from './booking.service';
import { BookingPartyResolver, BookingProfessionalResolver } from './booking-party.resolver';
import { BookingEntity } from '../entities/booking.entity';
import { BookingHistoryEntity } from '../entities/booking-history.entity';
import { CancelBookingDto, MarkNoShowDto, RescheduleBookingDto } from '../dto/booking.dto';
import {
  CUSTOMER_DISPLAY_NAME_DIRECTORY,
  CustomerDisplayNameDirectory,
  ORDER_DIRECTORY,
  OrderDirectory,
  PROFESSIONAL_DIRECTORY,
  ProfessionalDirectory,
} from '../ports';

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

export function toProfessionalBookingShape(booking: BookingEntity, customerDisplayName: string | null) {
  return { ...toBookingShape(booking), customerDisplayName };
}

/**
 * The customer's view, which names the order this booking produced (#225).
 *
 * A sibling of `toProfessionalBookingShape` rather than a widening of the
 * base, for the reason #224 established: the base shape is returned to EITHER
 * party (every mutation below does), so a field that belongs to one of them
 * cannot live there.
 *
 * It is the customer's alone on the evidence rather than by caution:
 * `OrderOwnerResolver` resolves an order's owner to `order.customerId`, so
 * `GET /v1/orders/:id` answers 404 to the professional. Handing them this id
 * would be handing them a reference that leads nowhere.
 *
 * `null` when no order exists — a booking can be held before anything is
 * ordered, and the receipt surface reads that as "nothing to show" rather
 * than as an error.
 */
export function toCustomerBookingShape(booking: BookingEntity, orderId: string | null) {
  return { ...toBookingShape(booking), orderId };
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
    @Inject(CUSTOMER_DISPLAY_NAME_DIRECTORY) private readonly customerNames: CustomerDisplayNameDirectory,
    @Inject(ORDER_DIRECTORY) private readonly orders: OrderDirectory,
  ) {}

  @Get('me/bookings')
  async myBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<PaginatedResult<ReturnType<typeof toCustomerBookingShape>[]>> {
    const { items, total } = await this.bookings.listForCustomer(user.userId, query.page, query.limit);
    // One commerce query for the whole page, not one per row -- the reason
    // `OrderDirectory` is batch-shaped.
    const orderIds = await this.orders.orderIdsFor(items.map((booking) => booking.id));
    return {
      value: items.map((booking) => toCustomerBookingShape(booking, orderIds.get(booking.id) ?? null)),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  @Get('me/professional-bookings')
  async myProfessionalBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ): Promise<PaginatedResult<ReturnType<typeof toProfessionalBookingShape>[]>> {
    const professionalId = await this.directory.professionalIdForOwner(user.userId);
    if (!professionalId) throw new NotFoundOrNotYoursException();
    const { items, total } = await this.bookings.listForProfessional(professionalId, query.page, query.limit);
    const displayNames = await this.customerNames.displayNamesFor(items.map((booking) => booking.customerId));
    return {
      value: items.map((booking) => toProfessionalBookingShape(booking, displayNames.get(booking.customerId) ?? null)),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  @ResolveOwner(BookingPartyResolver)
  @Get('bookings/:id')
  async getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const booking = await this.bookings.findById(id);
    if (!booking) throw new NotFoundOrNotYoursException();
    const role = await this.party.roleFor(id, user.userId);
    if (role === 'professional') {
      const displayNames = await this.customerNames.displayNamesFor([booking.customerId]);
      return toProfessionalBookingShape(booking, displayNames.get(booking.customerId) ?? null);
    }
    // The guard already refused anyone who is neither party, so this is the
    // customer.
    const orderIds = await this.orders.orderIdsFor([booking.id]);
    return toCustomerBookingShape(booking, orderIds.get(booking.id) ?? null);
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

    // `acceptConsequence` is only ever the caller's confirmation; the actor,
    // and therefore whether the booking's outcome terms govern the move, is
    // still derived from the session above (V3.3 #160).
    const booking = await this.bookings.reschedule(
      id,
      dto.newSlotId,
      { type: role, id: user.userId },
      dto.reason ?? null,
      undefined,
      { acceptConsequence: dto.acceptConsequence === true },
    );
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

  /**
   * The read half of the declaration — V3.3 `#42d-read` (#201).
   *
   * `BookingProfessionalResolver`, the same guard the POST carries: a
   * customer holding a valid session for their own booking is refused here
   * exactly as they are refused the declaration itself. What a customer may
   * eventually see of a declaration made against them belongs to `#42e`
   * (#162), which owns the objection they would act on; until that route
   * exists there is nothing for them to do with it, so nothing is disclosed.
   */
  @ResolveOwner(BookingProfessionalResolver)
  @Get('bookings/:id/no-show')
  async noShowState(@Param('id') id: string): Promise<BookingNoShowState> {
    const state = await this.bookings.noShowStateFor(id);
    if (!state) throw new NotFoundOrNotYoursException();
    return state;
  }

  @ResolveOwner(BookingProfessionalResolver)
  @Post('bookings/:id/no-show')
  async noShow(@Param('id') id: string, @Body() dto: MarkNoShowDto, @CurrentUser() user: AuthenticatedUser) {
    await this.bookings.markNoShow(id, { type: 'professional', id: user.userId }, dto.statement ?? null);
    const booking = await this.bookings.findById(id);
    if (!booking) throw new NotFoundOrNotYoursException();
    return toBookingShape(booking);
  }
}
