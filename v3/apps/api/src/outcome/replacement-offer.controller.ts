/**
 * DEMO BRANCH ONLY (DEMO-DEC-001 part B) — never merged to master.
 *
 * The customer's replacement-offer routes, keyed by the ORIGINAL (cancelled)
 * booking. Ownership: the original booking's customer (anyone else gets the
 * ownership guard's non-enumerating 404).
 *
 *   GET  /v1/bookings/:id/replacement-offer
 *   POST /v1/bookings/:id/replacement-offer/dismiss
 *   POST /v1/bookings/:id/replacement-offer/bookings   (Idempotency-Key header;
 *        body { slotId, acceptedPolicy? }) — a NEW booking with its own order and
 *        payment through the ordinary checkout, same response shape as POST /v1/bookings.
 */
import { BadRequestException, Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { ResolveOwner } from '@beauclick/ownership';
import { AuditLogger } from '@beauclick/events';
import { BookingCustomerResolver, BookingService, toBookingShape } from '@beauclick/booking';
import { toOrderDetail } from '@beauclick/commerce';

import { AcceptedPolicyDto } from '../checkout/checkout-disclosure';
import { CheckoutService } from '../checkout/checkout.service';
import { ReplacementOfferService } from './replacement-offer.service';

export class ReplacementBookingDto {
  @IsUUID()
  slotId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AcceptedPolicyDto)
  acceptedPolicy?: AcceptedPolicyDto;
}

@Controller('v1')
export class ReplacementOfferController {
  private readonly audit = new AuditLogger('commerce');

  constructor(
    private readonly offers: ReplacementOfferService,
    private readonly checkout: CheckoutService,
    private readonly bookings: BookingService,
    private readonly config: ConfigService,
  ) {}

  @ResolveOwner(BookingCustomerResolver)
  @Get('bookings/:id/replacement-offer')
  async view(@Param('id') id: string) {
    return this.offers.view(id);
  }

  @ResolveOwner(BookingCustomerResolver)
  @Post('bookings/:id/replacement-offer/dismiss')
  async dismiss(@Param('id') id: string) {
    const r = await this.offers.dismiss(id);
    this.audit.log({ action: 'commerce.replacement_offer_dismissed', bookingId: id });
    return r;
  }

  @ResolveOwner(BookingCustomerResolver)
  @Post('bookings/:id/replacement-offer/bookings')
  async book(
    @Param('id') id: string,
    @Body() dto: ReplacementBookingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const key = idempotencyKey?.trim();
    // Required here (optional on the ordinary checkout): it is what makes a retried
    // replacement converge on ONE attempt instead of being refused as a second one.
    if (!key || key.length > 200) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'درخواست نامعتبر است.' });

    // The offer's target is immutable; the lock hook re-validates everything under the lock.
    const target = await this.offers.view(id);
    const hooks = this.offers.checkoutHooks(id, key, dto.slotId);
    const base = this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api';
    const result = await this.checkout.checkout({
      customerId: user.userId,
      professionalId: target.professionalId,
      slotId: dto.slotId,
      serviceId: target.serviceId,
      idempotencyKey: key,
      callbackBaseUrl: `${base}/v1/payments/callback`,
      acceptedPolicy: dto.acceptedPolicy
        ? {
            policyKey: dto.acceptedPolicy.policyKey,
            policyVersion: dto.acceptedPolicy.policyVersion,
            copyKey: dto.acceptedPolicy.copyKey,
            copyVersion: dto.acceptedPolicy.copyVersion,
          }
        : null,
      replacement: hooks,
    });
    this.audit.log({ action: 'commerce.replacement_booking_attempted', bookingId: id, replacementBookingId: result.bookingId });

    const booking = await this.bookings.findById(result.bookingId);
    return {
      booking: booking ? toBookingShape(booking) : null,
      order: toOrderDetail(result.order),
      payment: { intentId: result.paymentIntentId, redirectUrl: result.redirectUrl },
    };
  }
}
