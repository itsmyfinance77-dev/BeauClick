import { BadRequestException, Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsOptional, ValidateNested } from 'class-validator';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';
import { BookingService, toBookingShape } from '@beauclick/booking';
import { toOrderDetail } from '@beauclick/commerce';
import { WaitlistEntryOwnerResolver } from '@beauclick/waitlist';

import { AcceptedPolicyDto } from '../checkout/checkout-disclosure';
import { WaitlistAcceptanceService } from './waitlist-acceptance.service';

/** Demo remediation F-8: the terms the customer ticked for the offered time, exactly as for any checkout. */
export class AcceptWaitlistOfferDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AcceptedPolicyDto)
  acceptedPolicy?: AcceptedPolicyDto;
}

/**
 * `POST /v1/waitlist/:id/accept` (Idempotency-Key header REQUIRED; body
 * `{ acceptedPolicy? }`) -- accepting an offer is a checkout: the response is
 * the same `{ booking, order, payment }` shape as `POST /v1/bookings`, with the
 * bank redirect when there is something to collect online.
 */
@Controller('v1')
export class WaitlistAcceptanceController {
  constructor(
    private readonly acceptance: WaitlistAcceptanceService,
    private readonly bookings: BookingService,
    private readonly config: ConfigService,
  ) {}

  @ResolveOwner(WaitlistEntryOwnerResolver)
  @Post('waitlist/:id/accept')
  async accept(
    @Param('id') id: string,
    @Body() dto: AcceptWaitlistOfferDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim();
    // Required (optional on the ordinary checkout): it is what makes a retried
    // acceptance converge on ONE booking/order instead of being refused.
    if (!key || key.length > 200) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'درخواست نامعتبر است.' });

    const base = this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api';
    const result = await this.acceptance.accept({
      entryId: id,
      customerId: user.userId,
      idempotencyKey: key,
      callbackBaseUrl: `${base}/v1/payments/callback`,
      // Copied field by field: exactly the four identifiers, or nothing.
      acceptedPolicy: dto.acceptedPolicy
        ? {
            policyKey: dto.acceptedPolicy.policyKey,
            policyVersion: dto.acceptedPolicy.policyVersion,
            copyKey: dto.acceptedPolicy.copyKey,
            copyVersion: dto.acceptedPolicy.copyVersion,
          }
        : null,
    });

    const booking = await this.bookings.findById(result.bookingId);
    return {
      booking: booking ? toBookingShape(booking) : null,
      order: toOrderDetail(result.order),
      payment: { intentId: result.paymentIntentId, redirectUrl: result.redirectUrl },
    };
  }
}
