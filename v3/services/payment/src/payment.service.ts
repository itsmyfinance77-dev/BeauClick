import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { emitEvent, AuditLogger } from '@beauclick/events';
import { DomainException } from '@beauclick/http';
import { assertNonNegativeAmount } from '@beauclick/money';

import { LIVE_INTENT_STATUSES, PaymentIntentEntity, PaymentIntentStatus } from './entities/payment-intent.entity';
import { PaymentAttemptEntity } from './entities/payment-attempt.entity';
import { PaymentOutboxEntity } from './entities/payment-outbox.entity';
import { RefundEntity, RefundKind, RefundStatus } from './entities/refund.entity';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { VerifyPaymentResult } from './providers/payment-provider.interface';
import { PaymentFailureReason, toPublicFailureReason, unresolvedVerification } from './payment-failure';

export class PaymentIntentNotFoundException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این مورد یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export class PaymentIntentNotPayableException extends DomainException {
  constructor(reason: string) {
    super('PAYMENT_INTENT_NOT_PAYABLE', 'این پرداخت دیگر قابل انجام نیست.', HttpStatus.CONFLICT, { reason });
  }
}

export class PaymentAmountMismatchException extends DomainException {
  constructor() {
    super('PAYMENT_AMOUNT_MISMATCH', 'مبلغ پرداخت‌شده با مبلغ سفارش مطابقت ندارد.', HttpStatus.CONFLICT);
  }
}

/**
 * Internal only -- never thrown out of the service.
 *
 * Deliberately NOT a `DomainException`: a verification deadline is not an
 * error the CUSTOMER should see, it is a fact about the gateway that turns
 * into an `unresolved` outcome and an honest result page. Making it a domain
 * exception would put a 4xx in front of somebody whose money may have moved.
 */
export class VerificationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gateway verification exceeded ${timeoutMs}ms`);
    this.name = 'VerificationTimeoutError';
  }
}

export interface CreateIntentInput {
  orderId: string;
  customerId: string;
  amountToman: number;
  providerKey?: string;
}

export interface InitiateResult {
  intent: PaymentIntentEntity;
  attempt: PaymentAttemptEntity;
  redirectUrl: string;
}

/**
 * What `prepareVerification` learned by asking the gateway. Carries no
 * database writes -- it is a pure description of the gateway's answer, so
 * the network call can happen outside any transaction.
 */
export interface PreparedVerification {
  attempt: PaymentAttemptEntity;
  intent: PaymentIntentEntity;
  /** Null when the attempt was already terminal -- nothing was asked of the gateway. */
  providerResult: VerifyPaymentResult | null;
  /** True when this callback is a replay of one already processed. */
  alreadyProcessed: boolean;
}

export interface VerificationOutcome {
  /**
   * `unresolved` is a real terminal-for-this-request state and NOT a failure:
   * the gateway could not be asked, or could not answer. Nothing was written,
   * the attempt is still open, and the caller must not settle, refund, or
   * confirm anything on it.
   */
  status: 'succeeded' | 'failed' | 'replayed' | 'unresolved';
  orderId: string;
  customerId: string;
  intentId: string;
  attemptId: string;
  amountToman: number;
  providerTransactionId: string | null;
  /** The gateway's own code. Stored and logged; never published to a browser. */
  failureCode: string | null;
  /**
   * The same fact narrowed to the closed public vocabulary (`QA-21`). This is
   * what the redirect contract carries and what the frontend renders.
   */
  failureReason: PaymentFailureReason | null;
}

export interface RequestRefundInput {
  orderId: string;
  amountToman: number;
  reason: string;
  /** Deterministic per cause, so the same cause can never refund twice. */
  requestKey: string;
  actorType: 'customer' | 'professional' | 'system' | 'admin';
  actorId: string | null;
  /**
   * Defaults to 'order'. Use 'duplicate_charge' for a second gateway charge
   * that should never have happened -- that money is outside the order's
   * accounting entirely, so it must not reduce the order's total or reverse
   * a commission that was correctly earned once.
   */
  kind?: RefundKind;
  /** Refund this SPECIFIC attempt rather than the order's primary one. Required for a duplicate charge. */
  paymentAttemptId?: string;
}

@Injectable()
export class PaymentService {
  private readonly auditLog = new AuditLogger('payment');

  constructor(
    @InjectRepository(PaymentIntentEntity) private readonly intents: Repository<PaymentIntentEntity>,
    @InjectRepository(PaymentAttemptEntity) private readonly attempts: Repository<PaymentAttemptEntity>,
    @InjectRepository(RefundEntity) private readonly refunds: Repository<RefundEntity>,
    private readonly dataSource: DataSource,
    private readonly providers: PaymentProviderRegistry,
    private readonly config: ConfigService,
  ) {}

  private get intentTtlMinutes(): number {
    const raw = Number(this.config.get('PAYMENT_INTENT_TTL_MINUTES'));
    return Number.isFinite(raw) && raw > 0 ? raw : 30;
  }

  /**
   * How long a server-to-server verification may take before it is treated as
   * unresolved.
   *
   * A deadline is mandatory rather than defensive. `prepareVerification` runs
   * inside an HTTP request the CUSTOMER'S BROWSER is waiting on, having just
   * been redirected back from a bank; an adapter that awaits a gateway which
   * accepted the connection and never answers holds that request, its
   * connection, and the customer, until something else gives up. `verify()`'s
   * contract does not require an adapter to impose its own timeout, so the
   * caller imposes one and every adapter inherits it.
   *
   * 15s by default: comfortably above a healthy Iranian gateway's round trip
   * and comfortably below the point at which a customer assumes the site is
   * broken.
   */
  private get verifyTimeoutMs(): number {
    const raw = Number(this.config.get('PAYMENT_VERIFY_TIMEOUT_MS'));
    return Number.isFinite(raw) && raw > 0 ? raw : 15_000;
  }

  // ---------------------------------------------------------------------
  // Intent
  // ---------------------------------------------------------------------

  /**
   * Creates the payment intent for an order, or returns the live one.
   *
   * Idempotent by `uq_payment_intents_live_order` -- a partial unique index
   * over orders with a non-terminal intent. Double-clicking "pay" therefore
   * cannot open two intents for one order, which would let a customer be
   * charged twice for the same booking.
   */
  async createIntentForOrder(input: CreateIntentInput, manager?: EntityManager): Promise<PaymentIntentEntity> {
    assertNonNegativeAmount(input.amountToman, 'payment amount');

    const existing = await this.findLiveIntentForOrder(input.orderId, manager);
    if (existing) return existing;

    const providerKey = input.providerKey ?? this.providers.defaultProviderKey();
    this.providers.get(providerKey); // fails closed now, not at redirect time

    const id = uuidv7();
    const run = async (m: EntityManager): Promise<PaymentIntentEntity> => {
      await m.insert(PaymentIntentEntity, {
        id,
        orderId: input.orderId,
        customerId: input.customerId,
        amountToman: input.amountToman,
        currency: 'IRT',
        status: 'created',
        providerKey,
        expiresAt: new Date(Date.now() + this.intentTtlMinutes * 60_000),
        succeededAt: null,
        failureCode: null,
      });
      return m.findOneOrFail(PaymentIntentEntity, { where: { id } });
    };

    try {
      return await (manager ? run(manager) : this.dataSource.transaction(run));
    } catch (err) {
      if (isUniqueViolation(err)) {
        const settled = await this.findLiveIntentForOrder(input.orderId);
        if (settled) return settled;
      }
      throw err;
    }
  }

  async findLiveIntentForOrder(orderId: string, manager?: EntityManager): Promise<PaymentIntentEntity | null> {
    const repo = manager ? manager.getRepository(PaymentIntentEntity) : this.intents;
    return repo.findOne({ where: { orderId, status: In([...LIVE_INTENT_STATUSES]) } });
  }

  async findIntent(intentId: string): Promise<PaymentIntentEntity | null> {
    return this.intents.findOne({ where: { id: intentId } });
  }

  /**
   * Sends the customer to the gateway.
   *
   * The gateway call happens here, deliberately outside any transaction: an
   * HTTP round trip to an external bank must never hold a database
   * connection and row locks open. The attempt row is written after the
   * gateway responds, keyed by the reference it gave us.
   */
  /**
   * `callbackBaseUrl` is the callback ROUTE PREFIX (`.../v1/payments/callback`),
   * NOT a full URL. The provider segment is appended HERE, from the intent's
   * own `provider.key`, so the return leg always addresses the same provider
   * that will verify it.
   *
   * `R31-17`: this used to receive a full callback URL, and the initial
   * checkout path hardcoded `.../callback/mock` in the controller while the
   * provider key is `sandbox`. The browser therefore returned to
   * `/callback/mock`, `handleCallback('mock', ref)` could not resolve the
   * `sandbox`-keyed attempt, and the payment never verified -- the order sat
   * pending. Deriving the segment from `provider.key` fixes it for the sandbox
   * and, crucially, makes any future real provider produce its own correct
   * callback path with no controller change.
   */
  async initiate(intentId: string, callbackBaseUrl: string, description: string): Promise<InitiateResult> {
    const intent = await this.intents.findOne({ where: { id: intentId } });
    if (!intent) throw new PaymentIntentNotFoundException();

    if (intent.status === 'succeeded') throw new PaymentIntentNotPayableException('already_paid');
    if (!LIVE_INTENT_STATUSES.includes(intent.status) && intent.status !== 'failed') {
      throw new PaymentIntentNotPayableException(intent.status);
    }
    if (intent.expiresAt.getTime() <= Date.now()) {
      await this.intents.update({ id: intent.id, status: In(['created', 'pending', 'failed']) }, { status: 'expired' });
      throw new PaymentIntentNotPayableException('expired');
    }

    // REUSE a live attempt rather than opening a second one.
    //
    // This is the fix for a double-charge hole found in Phase 2 live QA: a
    // retried checkout correctly returned the same booking and order, but
    // called initiate() again -- producing a second gateway reference. Two
    // live references for one intent are two separately-chargeable
    // transactions, and the second charge would have been silently absorbed
    // (its callback wins its own attempt CAS, then finds the order already
    // paid and reports a harmless-looking "replayed").
    //
    // The gateway's authority is still valid, so handing back the same
    // redirect URL is both correct and what the customer expects from a
    // re-tapped button.
    const live = await this.attempts.findOne({
      where: { paymentIntentId: intent.id, status: 'initiated' },
      order: { id: 'DESC' },
    });
    if (live?.redirectUrl) {
      return { intent, attempt: live, redirectUrl: live.redirectUrl };
    }

    const provider = this.providers.get(intent.providerKey);
    // The callback's provider segment is the intent's OWN provider key --
    // trusted server-side state, never a hardcoded literal or a client value.
    const callbackUrl = `${callbackBaseUrl.replace(/\/+$/, '')}/${provider.key}`;
    const initiated = await provider.initiate({
      paymentIntentId: intent.id,
      orderId: intent.orderId,
      amountToman: intent.amountToman,
      callbackUrl,
      description,
    });

    // The reference is the callback's ONLY key back to this attempt, so unlike
    // the diagnostic fields below it must never be silently shortened -- a
    // truncated reference would produce an attempt no callback can ever find,
    // and the customer's payment would be unreconcilable. An adapter returning
    // one this long is broken, and saying so beats a `22001` from PostgreSQL.
    if (initiated.providerReference.length > 128) {
      throw new Error(
        `Payment provider "${provider.key}" returned a ${initiated.providerReference.length}-character reference; the column holds 128.`,
      );
    }

    const attemptId = uuidv7();
    try {
      await this.dataSource.transaction(async (m) => {
        await m.insert(PaymentAttemptEntity, {
          id: attemptId,
          paymentIntentId: intent.id,
          providerKey: provider.key,
          providerReference: initiated.providerReference,
          status: 'initiated',
          requestedAmountToman: intent.amountToman,
          verifiedAmountToman: null,
          redirectUrl: initiated.redirectUrl,
          providerTransactionId: null,
          failureCode: null,
          providerResponse: null,
          verifiedAt: null,
        });

        await m.update(PaymentIntentEntity, { id: intent.id, status: In(['created', 'failed']) }, { status: 'pending' });

        await emitEvent(m, PaymentOutboxEntity, {
          aggregateType: 'payment',
          aggregateId: intent.id,
          eventType: 'PaymentInitiated',
          payload: {
            paymentIntentId: intent.id,
            paymentAttemptId: attemptId,
            orderId: intent.orderId,
            provider: provider.key,
            amountToman: intent.amountToman,
            currency: intent.currency,
          },
        });
      });
    } catch (err) {
      // `uq_payment_attempts_live_per_intent` is the structural backstop for
      // the same hole: a concurrent initiate lost the race, and its caller
      // must get the winner's redirect rather than a second gateway trip.
      if (isUniqueViolation(err)) {
        const winner = await this.attempts.findOne({
          where: { paymentIntentId: intent.id, status: 'initiated' },
          order: { id: 'DESC' },
        });
        if (winner?.redirectUrl) {
          return { intent, attempt: winner, redirectUrl: winner.redirectUrl };
        }
      }
      throw err;
    }

    this.auditLog.log({
      action: 'payment.initiated',
      intentId: intent.id,
      attemptId,
      orderId: intent.orderId,
      provider: provider.key,
      providerReference: initiated.providerReference,
    });

    return {
      intent: await this.intents.findOneOrFail({ where: { id: intent.id } }),
      attempt: await this.attempts.findOneOrFail({ where: { id: attemptId } }),
      redirectUrl: initiated.redirectUrl,
    };
  }

  // ---------------------------------------------------------------------
  // Callback verification -- the security-critical path
  // ---------------------------------------------------------------------

  /**
   * Step 1 of 2: ask the GATEWAY what happened. Performs no writes.
   *
   * Everything about this method is shaped by one rule: **a redirect from a
   * gateway is not evidence.** The browser carried those parameters, and a
   * customer can type the success URL by hand. `callbackParams` is used only
   * to identify which transaction to ask about; the answer comes from
   * `provider.verify()`, a server-to-server call.
   *
   * Split from `applyVerification` so the network round trip happens outside
   * the database transaction that records its result.
   */
  async prepareVerification(
    providerKey: string,
    providerReference: string,
    callbackParams: Record<string, string>,
  ): Promise<PreparedVerification> {
    const attempt = await this.attempts.findOne({ where: { providerKey, providerReference } });
    // An unknown reference is indistinguishable from a forged one, and gets
    // the same generic answer -- a caller must not be able to probe which
    // references exist.
    if (!attempt) throw new PaymentIntentNotFoundException();

    const intent = await this.intents.findOne({ where: { id: attempt.paymentIntentId } });
    if (!intent) throw new PaymentIntentNotFoundException();

    // Replay: the attempt already reached a terminal state. Return what it
    // says WITHOUT calling the gateway again and without writing anything.
    if (attempt.status !== 'initiated') {
      return { attempt, intent, providerResult: null, alreadyProcessed: true };
    }

    if (intent.expiresAt.getTime() <= Date.now() && intent.status !== 'succeeded') {
      return {
        attempt,
        intent,
        providerResult: { outcome: 'failed', paidAmountToman: null, providerTransactionId: null, failureCode: 'intent_expired' },
        alreadyProcessed: false,
      };
    }

    // The provider used to VERIFY comes from the attempt's own record, never
    // from the caller's path parameter. The lookup above already required
    // `attempt.providerKey === providerKey`, so this is the same provider --
    // but reading it from trusted state rather than the request makes the
    // authority explicit and cannot be spoofed by a crafted callback URL.
    const provider = this.providers.get(attempt.providerKey);

    // Every way this call can fail to produce an answer converges on ONE
    // shape: `unknown`. A timeout, a refused connection, a gateway 5xx an
    // adapter chose to throw on, and an adapter bug all mean the same thing
    // operationally -- nobody knows whether the money moved -- and the only
    // safe response to all four is identical: write nothing, keep the attempt
    // open, tell the customer the truth.
    //
    // Note what is NOT done here: this does not swallow the error silently and
    // report `failed`. That was the shape before, by omission, because
    // `failed` was the only word available; a thrown adapter produced a 500
    // and a customer staring at a stack-trace page after their card was
    // charged.
    let providerResult: VerifyPaymentResult;
    try {
      providerResult = await this.withVerifyDeadline(
        provider.verify({
          providerReference,
          expectedAmountToman: intent.amountToman,
          callbackParams,
        }),
      );
    } catch (err) {
      const timedOut = err instanceof VerificationTimeoutError;
      this.auditLog.error({
        action: 'payment.verification_unresolved',
        intentId: intent.id,
        attemptId: attempt.id,
        orderId: intent.orderId,
        provider: attempt.providerKey,
        // The adapter's message, not the gateway's response body: a transport
        // error names a host and a port, which is what an operator needs, and
        // carries none of the customer's data.
        cause: timedOut ? 'timeout' : String((err as Error)?.message ?? err).slice(0, 200),
      });
      providerResult = unresolvedVerification(timedOut ? 'verification_timeout' : 'verification_transport_error');
    }

    return { attempt, intent, providerResult, alreadyProcessed: false };
  }

  /**
   * Races a verification against the configured deadline.
   *
   * The adapter's own promise is deliberately NOT cancelled -- a `Promise`
   * cannot be, and an adapter that later resolves simply resolves into
   * nothing. What matters is that the customer's request stops waiting, and
   * that the attempt row is left in a state a later callback can still
   * resolve. It can: nothing was written.
   */
  private async withVerifyDeadline(pending: Promise<VerifyPaymentResult>): Promise<VerifyPaymentResult> {
    const deadlineMs = this.verifyTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new VerificationTimeoutError(deadlineMs)), deadlineMs);
          // Do not hold the process open for a deadline nobody is waiting on.
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Step 2 of 2: record the gateway's answer.
   *
   * Takes the caller's `EntityManager` so the payment record, the order's
   * transition to paid, and the booking's confirmation all commit together
   * -- see the checkout orchestrator for why those three must be atomic.
   *
   * Every write is a compare-and-swap on `status = 'initiated'`. Two
   * callbacks arriving simultaneously therefore produce exactly one
   * `PaymentSucceeded` event and exactly one commission downstream: the
   * loser sees zero affected rows and is reported as a replay.
   */
  async applyVerification(prepared: PreparedVerification, manager: EntityManager): Promise<VerificationOutcome> {
    const { attempt, intent, providerResult } = prepared;

    const base = {
      orderId: intent.orderId,
      customerId: intent.customerId,
      intentId: intent.id,
      attemptId: attempt.id,
      amountToman: intent.amountToman,
    };

    if (prepared.alreadyProcessed || providerResult === null) {
      return {
        ...base,
        status: 'replayed',
        providerTransactionId: attempt.providerTransactionId,
        failureCode: attempt.failureCode,
        failureReason: toPublicFailureReason(attempt.failureCode),
      };
    }

    // AMBIGUOUS: the gateway was not reached, or did not answer definitively.
    //
    // Every line below this point writes something -- the attempt's terminal
    // status, the intent's, an outbox event that five consumers act on, an
    // append-only ledger entry downstream. None of it may happen on a guess,
    // so this returns FIRST and writes NOTHING. The attempt stays `initiated`,
    // which is exactly the state a later callback, a customer retry, or an
    // operator's reconciliation needs it to be in.
    if (providerResult.outcome === 'unknown') {
      this.auditLog.warn({
        action: 'payment.verification_unresolved_applied',
        intentId: intent.id,
        attemptId: attempt.id,
        orderId: intent.orderId,
        failureCode: providerResult.failureCode,
      });
      return {
        ...base,
        status: 'unresolved',
        providerTransactionId: null,
        // The adapter's own code is kept for the operator...
        failureCode: providerResult.failureCode,
        // ...but the PUBLIC reason is `unresolved` unconditionally, never
        // derived from that code. An adapter reporting `outcome: 'unknown'`
        // with `failureCode: 'gateway_5xx'` would otherwise narrow to
        // `gateway_error`, whose copy promises the customer that any money
        // taken will come back -- a promise nobody can make about a payment
        // whose outcome is genuinely unknown. The outcome decides the public
        // reason here; the code only annotates it.
        failureReason: 'unresolved',
      };
    }

    // Amount tampering check. The gateway's own captured figure must match
    // what the intent recorded BEFORE the customer left for the gateway. A
    // mismatch is never treated as success, whatever the gateway said.
    //
    // The unit is checked, not assumed. This comparison is number-to-number,
    // so without an explicit currency the only thing asserting that both
    // sides mean TOMANS is the field's name -- and Iranian gateway APIs
    // commonly denominate in rials (1 toman = 10 rials). An adapter passing a
    // rial figure through would settle an order for a tenth of its value and
    // pass this equality check. An adapter that does not state its unit is
    // refused rather than trusted.
    const currencyMatches =
      providerResult.paidCurrency != null && providerResult.paidCurrency === intent.currency;

    const amountMatches =
      providerResult.outcome === 'succeeded' &&
      currencyMatches &&
      providerResult.paidAmountToman === intent.amountToman;

    if (providerResult.outcome === 'succeeded' && !amountMatches) {
      this.auditLog.error({
        action: 'payment.amount_mismatch',
        intentId: intent.id,
        attemptId: attempt.id,
        expected: intent.amountToman,
        expectedCurrency: intent.currency,
        reported: providerResult.paidAmountToman,
        // Distinguishes "wrong number" from "unit never stated / wrong unit",
        // which need different investigations.
        reportedCurrency: providerResult.paidCurrency ?? null,
      });
    }

    const succeeded = providerResult.outcome === 'succeeded' && amountMatches;
    // The gateway's own failure code wins when the gateway itself failed.
    // Only a gateway-reported SUCCESS whose amount disagrees is a mismatch --
    // an earlier version reported 'amount_mismatch' for every failure
    // (including a plain declined card), which would send a support engineer
    // hunting a tampering incident that never happened.
    const failureCode = fitToColumn(
      succeeded
        ? null
        : providerResult.outcome === 'failed'
          ? providerResult.failureCode
          : 'amount_mismatch',
      60,
    );

    const claimed = await manager
      .createQueryBuilder()
      .update(PaymentAttemptEntity)
      .set({
        status: succeeded ? 'succeeded' : 'failed',
        verifiedAmountToman: providerResult.paidAmountToman,
        providerTransactionId: fitToColumn(providerResult.providerTransactionId, 128),
        failureCode,
        providerResponse: sanitizeProviderResponse(providerResult.raw),
        verifiedAt: new Date(),
      })
      .where("id = :id AND status = 'initiated'", { id: attempt.id })
      .execute();

    if (claimed.affected !== 1) {
      const current = await manager.findOneOrFail(PaymentAttemptEntity, { where: { id: attempt.id } });
      return {
        ...base,
        status: 'replayed',
        providerTransactionId: current.providerTransactionId,
        failureCode: current.failureCode,
        failureReason: toPublicFailureReason(current.failureCode),
      };
    }

    await manager
      .createQueryBuilder()
      .update(PaymentIntentEntity)
      .set(
        succeeded
          ? { status: 'succeeded' as PaymentIntentStatus, succeededAt: new Date(), failureCode: null }
          : { status: 'failed' as PaymentIntentStatus, failureCode },
      )
      .where('id = :id AND status IN (:...open)', { id: intent.id, open: ['created', 'pending'] })
      .execute();

    await emitEvent(manager, PaymentOutboxEntity, {
      aggregateType: 'payment',
      aggregateId: intent.id,
      eventType: succeeded ? 'PaymentSucceeded' : 'PaymentFailed',
      payload: {
        paymentIntentId: intent.id,
        paymentAttemptId: attempt.id,
        orderId: intent.orderId,
        customerId: intent.customerId,
        provider: attempt.providerKey,
        amountToman: intent.amountToman,
        currency: intent.currency,
        providerTransactionId: providerResult.providerTransactionId,
        failureCode,
      },
    });

    this.auditLog.log({
      action: succeeded ? 'payment.succeeded' : 'payment.failed',
      intentId: intent.id,
      attemptId: attempt.id,
      orderId: intent.orderId,
      failureCode,
    });

    return {
      ...base,
      status: succeeded ? 'succeeded' : 'failed',
      providerTransactionId: providerResult.providerTransactionId,
      failureCode,
      failureReason: toPublicFailureReason(failureCode),
    };
  }

  // ---------------------------------------------------------------------
  // Refunds
  // ---------------------------------------------------------------------

  /**
   * Issues a refund, at most once per `requestKey`.
   *
   * Three phases, in this order, for a reason:
   *   1. write the refund row (so a crash leaves evidence, not a ghost),
   *   2. call the gateway (outside any transaction),
   *   3. compare-and-swap the row to its outcome.
   *
   * A replayed call short-circuits at phase 1 on the unique constraint and
   * returns the existing refund -- the gateway is never asked twice.
   */
  async refund(input: RequestRefundInput): Promise<RefundEntity> {
    assertNonNegativeAmount(input.amountToman, 'refund amount');

    const existing = await this.refunds.findOne({ where: { orderId: input.orderId, requestKey: input.requestKey } });
    if (existing) return existing;

    const intent = await this.intents.findOne({ where: { orderId: input.orderId, status: 'succeeded' } });
    if (!intent) throw new PaymentIntentNotFoundException();

    const attempt = input.paymentAttemptId
      ? await this.attempts.findOne({ where: { id: input.paymentAttemptId } })
      : await this.attempts.findOne({
          where: { paymentIntentId: intent.id, status: 'succeeded' },
          order: { id: 'DESC' },
        });

    const refundId = uuidv7();
    try {
      await this.refunds.insert({
        id: refundId,
        orderId: input.orderId,
        paymentIntentId: intent.id,
        paymentAttemptId: attempt?.id ?? null,
        requestKey: input.requestKey,
        amountToman: input.amountToman,
        status: 'pending',
        kind: input.kind ?? 'order',
        providerRefundReference: null,
        failureCode: null,
        reason: input.reason,
        requestedByActorType: input.actorType,
        requestedByActorId: input.actorId,
        completedAt: null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const settled = await this.refunds.findOne({ where: { orderId: input.orderId, requestKey: input.requestKey } });
        if (settled) return settled;
      }
      throw err;
    }

    const provider = this.providers.get(intent.providerKey);

    if (!provider.supportsAutomaticRefund) {
      // Honest outcome, not a failure: the money still has to move, just via
      // the manual settlement path rather than an API this gateway lacks.
      await this.completeRefund(refundId, 'manual_required', null, 'gateway_has_no_refund_api');
      return this.refunds.findOneOrFail({ where: { id: refundId } });
    }

    const result = await provider.refund({
      providerReference: attempt?.providerReference ?? '',
      providerTransactionId: attempt?.providerTransactionId ?? null,
      amountToman: input.amountToman,
      reason: input.reason,
      idempotencyKey: `${input.orderId}:${input.requestKey}`,
    });

    await this.completeRefund(
      refundId,
      result.outcome === 'succeeded' ? 'succeeded' : 'failed',
      fitToColumn(result.providerRefundReference, 128),
      fitToColumn(result.failureCode, 60),
    );

    this.auditLog.log({
      action: 'payment.refund',
      refundId,
      orderId: input.orderId,
      amountToman: input.amountToman,
      outcome: result.outcome,
    });

    return this.refunds.findOneOrFail({ where: { id: refundId } });
  }

  private async completeRefund(
    refundId: string,
    status: RefundStatus,
    providerRefundReference: string | null,
    failureCode: string | null,
  ): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const claimed = await m
        .createQueryBuilder()
        .update(RefundEntity)
        .set({ status, providerRefundReference, failureCode, completedAt: new Date() })
        .where("id = :refundId AND status = 'pending'", { refundId })
        .execute();

      if (claimed.affected !== 1) return;

      const refund = await m.findOneOrFail(RefundEntity, { where: { id: refundId } });
      if (status !== 'succeeded') return;

      await emitEvent(m, PaymentOutboxEntity, {
        aggregateType: 'payment',
        aggregateId: refund.paymentIntentId,
        eventType: 'RefundCompleted',
        payload: {
          refundId: refund.id,
          paymentIntentId: refund.paymentIntentId,
          orderId: refund.orderId,
          amountToman: refund.amountToman,
          // Consumers MUST branch on this: a duplicate-charge correction is
          // not a refund of the order and must not reduce its total.
          kind: refund.kind,
          providerRefundReference,
          completedAt: new Date().toISOString(),
        },
      });
    });
  }

  async findRefund(refundId: string): Promise<RefundEntity | null> {
    return this.refunds.findOne({ where: { id: refundId } });
  }

  async listRefundsForOrder(orderId: string): Promise<RefundEntity[]> {
    return this.refunds.find({ where: { orderId }, order: { id: 'ASC' } });
  }

  async findAttemptById(attemptId: string): Promise<PaymentAttemptEntity | null> {
    return this.attempts.findOne({ where: { id: attemptId } });
  }
}

/**
 * Fits an adapter-supplied string into the column that receives it.
 *
 * Not tidiness. `payment_attempts.failure_code` is `varchar(60)` and
 * `provider_transaction_id` is `varchar(128)`; PostgreSQL does not truncate an
 * oversized value, it raises `22001 value too long`. That error is raised
 * INSIDE the callback's transaction, which means an adapter returning a
 * longer-than-60-character failure message -- a free-text Persian bank
 * message, say, which is exactly what several Iranian gateways return --
 * aborts the whole transaction and hands the customer a 500 instead of a
 * result page. Worse, it does so on the FAILURE path, where the customer is
 * already having a bad time.
 *
 * The bound belongs here, at the boundary where an external system's data
 * enters ours, rather than in each adapter: no adapter can be trusted to know
 * this schema's widths, and every one of them would have to remember.
 *
 * Found by `payment-verification-contract.pg-spec.ts`.
 */
function fitToColumn(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

/**
 * Flattens a provider's raw response to scalars and drops anything that
 * looks like a credential, before it is written to a column that a support
 * engineer will read. Defence in depth behind the adapter contract, which
 * already says raw responses must be credential-free.
 */
function sanitizeProviderResponse(
  raw: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null> | null {
  if (!raw) return null;
  const forbidden = /merchant|secret|token|key|password|authorization|pan|card/i;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (forbidden.test(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[key] = value as string | number | boolean | null;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}
