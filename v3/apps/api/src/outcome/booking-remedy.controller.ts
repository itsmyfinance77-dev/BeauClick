import { Body, Controller, Param, Post } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';
import { BookingCustomerResolver } from '@beauclick/booking';

import { CustomerRemedyResolutionService } from './customer-remedy-resolution.service';
import { RemedyChoiceDto } from './remedy-choice.dto';

/**
 * `POST /api/v1/bookings/:id/remedy` — V3.3 #161 (`#42d`), ADR-051 §8.
 *
 * Lives in `apps/api`, not `BookingController`, for the same reason
 * `CheckoutController` does: the customer's remedy needs booking-service's
 * reschedule AND Commerce's remedy-choice record in one transaction, and
 * ADR-011 forbids `services/booking` importing `services/commerce`.
 *
 * `BookingCustomerResolver` at the HTTP boundary, re-checked nowhere else in
 * this handler because there is nothing left to re-derive: the resolver
 * already answers "is this session the customer of this booking", and the
 * resolution service asks the customer's own remedy row nothing about who is
 * calling.
 */
@Controller('v1')
export class BookingRemedyController {
  constructor(private readonly resolution: CustomerRemedyResolutionService) {}

  @ResolveOwner(BookingCustomerResolver)
  @Post('bookings/:id/remedy')
  async remedy(@Param('id') id: string, @Body() dto: RemedyChoiceDto, @CurrentUser() user: AuthenticatedUser) {
    const resolved = await this.resolution.resolve(id, user.userId, dto.choice, dto.newSlotId ?? null);
    return { chosen: resolved.chosen, resolvedBy: resolved.resolvedBy };
  }
}
