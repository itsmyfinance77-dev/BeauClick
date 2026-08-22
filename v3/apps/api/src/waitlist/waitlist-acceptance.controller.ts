import { Controller, Param, Post } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';
import { toBookingShape } from '@beauclick/booking';
import { WaitlistEntryOwnerResolver } from '@beauclick/waitlist';

import { WaitlistAcceptanceService } from './waitlist-acceptance.service';

@Controller('v1')
export class WaitlistAcceptanceController {
  constructor(private readonly acceptance: WaitlistAcceptanceService) {}

  @ResolveOwner(WaitlistEntryOwnerResolver)
  @Post('waitlist/:id/accept')
  async accept(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    const booking = await this.acceptance.accept(id, user.userId);
    return toBookingShape(booking);
  }
}
