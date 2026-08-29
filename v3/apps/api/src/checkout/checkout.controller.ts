import { Body, Controller, Get, Headers, Param, Post, Query, Redirect } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser, CurrentUser, SkipResponseEnvelope } from '@beauclick/http';
import { Public, policy } from '@beauclick/auth';
import { CreateBookingDto, toBookingShape, BookingService } from '@beauclick/booking';
import { toOrderDetail } from '@beauclick/commerce';
import { SANDBOX_DECISIONS, SandboxDecision, SandboxPaymentProvider, PaymentService } from '@beauclick/payment';

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
 *
 * Throttled under the `mutation` policy, deliberately tighter than the
 * default: creating a booking claims a real slot, creates an order, and
 * opens a gateway attempt. No legitimate customer does that thirty times a
 * minute, and each one costs real downstream work.
 */
@Throttle(policy('mutation'))
@Controller('v1')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly bookings: BookingService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The callback ROUTE PREFIX, without a provider segment. `PaymentService.initiate`
   * appends the intent's own provider key, so the return leg always addresses
   * the provider that will verify it. `R31-17`: this previously returned a full
   * URL hardcoding `/callback/mock`, which never matched the `sandbox`-keyed
   * attempt and left every browser payment stuck pending.
   */
  private callbackBaseUrl(): string {
    const base = this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api';
    return `${base}/v1/payments/callback`;
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
      callbackBaseUrl: this.callbackBaseUrl(),
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
 *
 * **Throttling: `read` (generous), NOT `mutation`, and NOT exempt.**
 * Deliberate, because the failure modes are asymmetric. Every callback for
 * every customer arrives from the GATEWAY's own small set of IPs, so they
 * all share one IP bucket -- and a false 429 here means a customer's money
 * moved while their booking stayed unconfirmed, the worst outcome in the
 * system. A tight limit would manufacture exactly that. Full exemption was
 * also rejected: this route is `@Public()` and reachable by anyone.
 *
 * The generous limit is safe because throttling is NOT what protects this
 * endpoint -- the server-to-server verification does. A flood cannot
 * fabricate a payment, cannot replay one (verification returns `replayed`,
 * and `markPaid` is a compare-and-swap), and cannot enumerate anything (a
 * forged reference is indistinguishable from an unpaid one). The limit here
 * bounds resource abuse only.
 *
 * **Revisit when GAP-06b lands.** This policy is calibrated against the
 * sandbox's volume characteristics, which are this environment's, not a real
 * gateway's. A real gateway's callback rate and source-IP behaviour must be
 * measured and this limit re-derived from it -- see V3_SECURITY_MODEL.md.
 */
@Throttle(policy('read'))
@Controller('v1/payments')
export class PaymentCallbackController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly payments: PaymentService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The redirect contract (`QA-21`).
   *
   * Three parameters, and the third is the point of this change: `reason`
   * carries WHY a payment did not succeed, drawn from the closed public
   * vocabulary in `payment-failure.ts`. Before it, every non-success collapsed
   * into `status=failed`, and a customer who simply pressed "cancel" at their
   * bank was told their payment had been refused -- which sends them looking
   * for a problem with their card that does not exist.
   *
   * What is deliberately NOT here:
   *
   *  - the gateway's own failure code. It is provider-shaped and unbounded,
   *    and a redirect URL is browser history, a referrer header, and whatever
   *    analytics the result page loads. `toPublicFailureReason` narrows it.
   *  - any amount, reference, or settlement id. The result page RE-FETCHES the
   *    order from an authenticated endpoint for every figure it shows, so a
   *    customer editing this query string changes the sentence at the top and
   *    nothing else. That property is load-bearing and predates this change;
   *    adding `reason` must not and does not weaken it.
   *
   * `reason` is omitted entirely rather than sent empty when there is none --
   * a successful payment has no failure reason, and `reason=` would invite a
   * frontend to render one.
   */
  private resultUrl(status: string, orderId: string, reason: string | null): string {
    const base = this.config.get<string>('PUBLIC_WEB_BASE_URL') ?? 'http://localhost:3100';
    const query = new URLSearchParams({ status, orderId });
    if (reason) query.set('reason', reason);
    return `${base}/checkout/result?${query.toString()}`;
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

    // The reason is attached only to the states where it MEANS something.
    // A refunded or duplicate-refunded outcome succeeded at the gateway and
    // was corrected afterwards; labelling either with a failure reason would
    // describe the wrong event. `unresolved` keeps its reason, because
    // "we could not reach your bank" and "your bank timed out" are the same
    // sentence to a customer and the page must say it.
    const reason = status === 'failed' || status === 'unresolved' ? result.outcome.failureReason : null;

    // 303 See Other: the browser must follow with GET even when the gateway
    // returned via POST, so a refresh of the result page cannot re-submit.
    return { url: this.resultUrl(status, result.outcome.orderId, reason), statusCode: 303 };
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
    // Pass the base only; `initiate` appends the intent's own provider key.
    const initiated = await this.payments.initiate(
      intentId,
      `${base}/v1/payments/callback`,
      `پرداخت سفارش ${intent.orderId}`,
    );
    return { redirectUrl: initiated.redirectUrl };
  }
}

/**
 * The sandbox gateway's own checkout page -- the simulated BANK, not part of
 * BeauClick's payment domain.
 *
 * It stands in for the page a real gateway would host. Reachable only while
 * SandboxPaymentProvider itself is enabled, which fails closed in production
 * on two independent conditions. The `isEnabled()` re-check here is NOT
 * redundant with the registry's: this route is `@Public()` (a real gateway's
 * page carries no BeauClick session), so it is reachable without
 * authentication and must therefore refuse on its own rather than trusting
 * that some earlier layer already did.
 */
@Controller('v1/sandbox-gateway')
export class SandboxGatewayController {
  constructor(private readonly sandbox: SandboxPaymentProvider) {}

  @Public()
  @Post(':reference/decide')
  async decide(@Param('reference') reference: string, @Body() body: { decision?: string }) {
    if (!this.sandbox.isEnabled()) {
      return { accepted: false, reason: 'sandbox_gateway_disabled' };
    }

    // An unrecognised decision is REFUSED, never coerced to a default. The
    // previous shape (`paid?: boolean`, where anything but an explicit
    // `false` meant "paid") would have turned a typo'd field name into a
    // successful payment -- the exact class of leniency a payment path
    // should never have, sandbox or not.
    const decision = body?.decision;
    if (!decision || !SANDBOX_DECISIONS.includes(decision as SandboxDecision)) {
      return { accepted: false, reason: 'unknown_decision' };
    }

    const accepted = await this.sandbox.decide(reference, decision as SandboxDecision);
    return { accepted };
  }
}
