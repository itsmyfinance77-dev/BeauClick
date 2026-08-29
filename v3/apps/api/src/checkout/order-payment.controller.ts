import { Controller, Param, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedUser, CurrentUser } from '@beauclick/http';
import { policy } from '@beauclick/auth';
import { OrderOwnerResolver } from '@beauclick/commerce';
import { ResolveOwner } from '@beauclick/ownership';

import { CheckoutService } from './checkout.service';

/**
 * `POST /v1/orders/:id/payment/retry` — send a customer back to the gateway
 * for an order whose payment failed (V3.1 Phase F design, §2 of
 * `16_CHECKOUT_RESULT.md`).
 *
 * ## Why it lives here rather than in commerce or in payment
 *
 * The same reason `CheckoutController` owns `POST /v1/bookings`: the command
 * spans two domains. Deciding whether a retry is permitted needs the ORDER's
 * status (commerce) and the INTENT's state and stored failure code (payment),
 * and ADR-011 forbids either service importing the other. The composition root
 * is where that join is allowed to happen, and putting the route anywhere else
 * would mean either a module-boundary violation or a second gateway flow.
 *
 * ## Why it is order-scoped
 *
 * The redirect contract carries `status`, `orderId`, and `reason` — no
 * `intentId`, deliberately. An intent id in a URL is a payment-domain
 * identifier written into browser history, referrer headers, and every
 * analytics script the result page loads, and it buys nothing the customer's
 * own order id does not already provide. So the browser names the order and
 * the SERVER resolves which intent that means, from its own records.
 *
 * ## The ownership boundary
 *
 * `@ResolveOwner(OrderOwnerResolver)` is the same guard every other
 * order-scoped route uses. It resolves the owner from `commerce.orders` and
 * compares it to the verified session, and returns an identical
 * `NOT_FOUND_OR_NOT_YOURS` whether the order does not exist or belongs to
 * somebody else — so this route cannot be used to discover which order ids are
 * real. The param is named `id` because that is what the resolver reads;
 * renaming it would silently disable the check.
 *
 * `CheckoutService.retryPayment` re-checks ownership against the intent's own
 * `customerId` as well. Redundant on purpose: the two reads come from
 * different schemas, and a disagreement between them fails closed.
 *
 * ## Throttling
 *
 * `mutation`, the tighter policy — the same one `POST /v1/bookings` carries,
 * and for the same reason. A successful call opens a gateway transaction. No
 * legitimate customer does that thirty times a minute.
 */
@Throttle(policy('mutation'))
@Controller('v1/orders')
export class OrderPaymentController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The callback ROUTE PREFIX, without a provider segment — `initiate` appends
   * the intent's own provider key, so the return leg always addresses the
   * provider that will verify it. Identical to `CheckoutController`'s; see
   * `R31-17` there for what happened when this was a hardcoded full URL.
   */
  private callbackBaseUrl(): string {
    const base = this.config.get<string>('PUBLIC_API_BASE_URL') ?? 'http://localhost:3099/api';
    return `${base}/v1/payments/callback`;
  }

  /**
   * Returns `{ redirectUrl }` and nothing else — no provider reference, no
   * attempt id, no intent id, no stored failure code.
   *
   * Refuses with `PAYMENT_RETRY_NOT_AVAILABLE` and a `reason` from the closed
   * `PAYMENT_RETRY_REFUSALS` set. The refusal vocabulary is closed for the
   * same reason the failure vocabulary is: the alternative is an internal
   * state name or a provider code reaching a browser.
   */
  @ResolveOwner(OrderOwnerResolver)
  @Post(':id/payment/retry')
  async retry(@Param('id') orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.checkout.retryPayment({
      orderId,
      customerId: user.userId,
      callbackBaseUrl: this.callbackBaseUrl(),
    });
  }
}
