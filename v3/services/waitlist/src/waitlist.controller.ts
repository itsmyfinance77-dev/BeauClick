import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';

import { WaitlistService } from './waitlist.service';
import { WaitlistEntryEntity } from './entities/waitlist-entry.entity';
import { JoinWaitlistDto } from './dto/join-waitlist.dto';
import { WaitlistEntryOwnerResolver, WaitlistProfessionalResolver } from './waitlist-owner.resolver';
import { OfferNotAvailableException, WaitlistEntryNotFoundException } from './waitlist.errors';

function toEntryShape(entry: WaitlistEntryEntity) {
  return {
    id: entry.id,
    customerId: entry.customerId,
    professionalId: entry.professionalId,
    serviceId: entry.serviceId,
    status: entry.status,
    offeredSlotId: entry.offeredSlotId,
    offerExpiresAt: entry.offerExpiresAt?.toISOString() ?? null,
    resultingBookingId: entry.resultingBookingId,
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * Reads and the non-cross-domain transitions (decline, remove). Accepting
 * an offer lives on its own controller in the composition root
 * (`apps/api`'s `WaitlistAcceptanceController`) for the identical reason
 * booking creation does: it spans booking-service and waitlist-service in
 * one transaction, which only `apps/api` may compose (ADR-011).
 */
@Controller('v1')
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Post('waitlist')
  async join(@CurrentUser() user: AuthenticatedUser, @Body() dto: JoinWaitlistDto) {
    const entry = await this.waitlist.join({
      customerId: user.userId,
      professionalId: dto.professionalId,
      serviceId: dto.serviceId ?? null,
    });
    return toEntryShape(entry);
  }

  @Get('me/waitlist')
  async myEntries(@CurrentUser() user: AuthenticatedUser) {
    return (await this.waitlist.listForCustomer(user.userId)).map(toEntryShape);
  }

  @ResolveOwner(WaitlistProfessionalResolver)
  @Get('providers/:professionalId/waitlist')
  async professionalQueue(@Param('professionalId') professionalId: string) {
    return (await this.waitlist.listForProfessional(professionalId)).map(toEntryShape);
  }

  @ResolveOwner(WaitlistEntryOwnerResolver)
  @Post('waitlist/:id/decline')
  async decline(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const entry = await this.waitlist.decline(id, user.userId);
    if (!entry) throw new OfferNotAvailableException();
    return toEntryShape(entry);
  }

  @ResolveOwner(WaitlistEntryOwnerResolver)
  @Post('waitlist/:id/remove')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const ok = await this.waitlist.remove(id, user.userId);
    if (!ok) throw new WaitlistEntryNotFoundException();
    return { removed: true };
  }
}
