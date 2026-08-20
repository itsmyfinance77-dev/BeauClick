import { Body, Controller, Get, Headers, Param, Post, Query, Redirect } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser, CurrentUser, SkipResponseEnvelope } from '@beauclick/http';
import { Public } from '@beauclick/auth';
import { CreateBookingDto, toBookingShape, BookingService } from '@beauclick/booking';
import { toOrderDetail } from '@beauclick/commerce';
import { MockGatewayProvider, PaymentService } from '@beauclick/payment';

import { CheckoutService } from './checkout.service';

/**
 * `POST /v1/bookings` -- the one endpoint that spans booking and commerce.
 *
 * It lives in `apps/api` rather than in booking-service because creating a
 * booking and its order in ONE transaction requires both modules, and
 * ADR-011 forbids either service importing the other. Splitting the
 * `/v1/bookings` resource across two controllers is the honest cost of that
 * boundary; the alternative -- letting booking-service reach into commerce
 * -- would trade a small routing oddity for a real architectural leak.
 */
@Controller('v1')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly bookings: BookingService,
    private readonly config: ConfigService,
  ) {}

  private callbackUrl(): string {
    const base = this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api';
    return `${base}/v1/payments/callback/mock`;
  }

  /**
   * `Idempotency-Key` is a HEADER, not a body field, deliberately: it is a
   * property of the REQUEST, not of the booking, and keeping it out of the
   * body means `forbidNonWhitelisted` still rejects any other unexpected
   * field -- including anything price-shaped.
   */
  @Post('bookings')
  async create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.checkout.checkout({
      customerId: user.userId,
      professionalId: dto.professionalId,
      slotId: dto.slotId,
      serviceId: dto.serviceId ?? null,
      idempotencyKey: idempotencyKey ?? null,
      callbackUrl: this.callbackUrl(),
    });

    const booking = await this.bookings.findById(result.bookingId);
    return {
      booking: booking ? toBookingShape(booking) : null,
      order: toOrderDetail(result.order),
      payment: { intentId: result.paymentIntentId, redirectUrl: result.redirectUrl },
    };
  }
}

/**
 * Gateway callbacks and the payment surface.
 *
 * The callback route is `@Public()` because the gateway redirects a browser
 * here and there is no session guarantee at that moment -- which is exactly
 * why NOTHING about the outcome is derived from the request. The provider
 * reference identifies the transaction; a server-to-server verification
 * decides what happened. An attacker hitting this URL with a forged
 * reference gets a generic not-found; with a real reference for an unpaid
 * transaction, they get a verified failure.
 */
@Controller('v1/payments')
export class PaymentCallbackController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly payments: PaymentService,
    private readonly config: ConfigService,
  ) {}

  private resultUrl(status: string, orderId: string): string {
    const base = this.config.get<string>('PUBLIC_WEB_BASE_URL') ?? 'http://localhost:3100';
    return `${base}/checkout/result?status=${encodeURIComponent(status)}&orderId=${encodeURIComponent(orderId)}`;
  }

  /**
   * Both GET and POST: Iranian gateways differ on which they use for the
   * customer return leg, and an adapter should not need a new route to
   * support one.
   */
  @Public()
  @SkipResponseEnvelope()
  @Get('callback/:provider')
  @Redirect()
  async callbackGet(@Param('provider') provider: string, @Query() query: Record<string, string>) {
    return this.handle(provider, query);
  }

  @Public()
  @SkipResponseEnvelope()
  @Post('callback/:provider')
  @Redirect()
  async callbackPost(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
    @Body() body: Record<string, string>,
  ) {
    return this.handle(provider, { ...query, ...(body ?? {}) });
  }

  private async handle(provider: string, params: Record<string, string>): Promise<{ url: string; statusCode: number }> {
    // The gateway's reference is the ONLY thing taken from the callback, and
    // only as an identifier. Several gateways name it differently.
    const reference = params.reference ?? params.Authority ?? params.authority ?? params.token ?? '';

    const result = await this.checkout.handleCallback(provider, reference, params);
    const status = result.duplicateChargeRefunded
      ? 'duplicate_refunded'
      : result.refundIssued
        ? 'refunded'
        : result.outcome.status;

    // 303 See Other: the browser must follow with GET even when the gateway
    // returned via POST, so a refresh of the result page cannot re-submit.
    return { url: this.resultUrl(status, result.outcome.orderId), statusCode: 303 };
  }

  /** Re-initiate payment for an order whose first attempt failed or was abandoned. */
  @Post('intents/:intentId/initiate')
  async reinitiate(@Param('intentId') intentId: string, @CurrentUser() user: AuthenticatedUser) {
    const intent = await this.payments.findIntent(intentId);
    // Ownership is checked against the intent's own customer, from the
    // verified session -- an intent id alone is never authority to pay.
    if (!intent || intent.customerId !== user.userId) {
      return { redirectUrl: null };
    }
    const base = this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api';
    const initiated = await this.payments.initiate(
      intentId,
      `${base}/v1/payments/callback/${intent.providerKey}`,
      `پرداخت سفارش ${intent.orderId}`,
    );
    return { redirectUrl: initiated.redirectUrl };
  }
}

/**
 * The local mock gateway's own checkout page -- the simulated BANK, not part
 * of BeauClick's payment domain.
 *
 * It stands in for the page a real gateway would host. Reachable only while
 * MockGatewayProvider itself is enabled, which fails closed in production.
 */
@Controller('v1/mock-gateway')
export class MockGatewayController {
  constructor(private readonly mock: MockGatewayProvider) {}

  @Public()
  @Post(':reference/settle')
  async settle(@Param('reference') reference: string, @Body() body: { paid?: boolean }) {
    if (!this.mock.isEnabled()) {
      return { accepted: false, reason: 'mock_gateway_disabled' };
    }
    const accepted = await this.mock.settle(reference, body?.paid !== false);
    return { accepted };
  }
}
