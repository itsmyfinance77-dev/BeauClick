import { Injectable, Logger } from '@nestjs/common';
import { DeliveryRequest, DeliveryResult, NotificationChannelPort } from './notification-channel.port';

/**
 * In-app delivery.
 *
 * The only channel that is genuinely, fully implemented in Phase 3 -- and it
 * needs no external provider at all, because the notification row IS the
 * delivery. `send` succeeds unconditionally, which is not a shortcut: the
 * message becomes visible in the notification centre the moment the row
 * exists, so there is no second system whose acceptance could fail.
 */
@Injectable()
export class InAppChannel implements NotificationChannelPort {
  readonly key = 'in_app';
  readonly providerVerified = true;

  async send(_request: DeliveryRequest): Promise<DeliveryResult> {
    return { delivered: true };
  }
}

/**
 * A recipient lookup, implemented by the composition root.
 *
 * notification-service must not read identity's tables (ADR-011), and more to
 * the point must not HOLD phone numbers or email addresses: the recipient is
 * fetched at dispatch time and never persisted on the notification row. V2
 * stored `recipient` and then had to scrub the column on account deletion --
 * a whole class of privacy work that not storing it avoids entirely.
 */
export interface RecipientResolverPort {
  resolve(userId: string): Promise<{ phone: string | null; email: string | null }>;
}

export const RECIPIENT_RESOLVER = Symbol('BEAUCLICK_RECIPIENT_RESOLVER');

/**
 * SMS delivery through a provider abstraction, with a logging provider behind
 * it in this environment.
 *
 * **No real SMS is sent, and this class says so** (`providerVerified: false`).
 * GAP-11 remains open: no SMS credentials exist anywhere this project has
 * run, so a real adapter's field and encoding semantics could not be
 * exercised. Shipping one unverified would be a liability rather than an
 * asset -- the same judgement Phase 2 made about a payment gateway adapter.
 *
 * What IS real here: the recipient lookup, the missing-recipient failure
 * classification, the retryable/permanent distinction, and the fact that the
 * message body never reaches a persisted field.
 */
@Injectable()
export class LoggingSmsChannel implements NotificationChannelPort {
  readonly key = 'sms';
  readonly providerVerified = false;
  private readonly logger = new Logger('SmsChannel');

  constructor(private readonly recipients: RecipientResolverPort) {}

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const { phone } = await this.recipients.resolve(request.userId);
    if (!phone) {
      // Permanent: a customer with no phone number on file will not acquire
      // one because we retried. Retrying this forever is how a dead-letter
      // queue fills with messages that were never deliverable.
      return { delivered: false, errorCode: 'no_phone_on_file', retryable: false };
    }

    // The number is deliberately NOT logged. An SMS log line containing a
    // phone number is a personal-data leak into every log aggregator that
    // ever ingests it.
    this.logger.log(
      `[SIMULATED SMS] notification=${request.notificationId} template=${request.templateKey} chars=${request.rendered.short.length}`,
    );
    return { delivered: true };
  }
}

/**
 * Email delivery through a provider abstraction, with a logging provider
 * behind it in this environment. Same disclosure as SMS: `providerVerified`
 * is false and no mail leaves this process.
 */
@Injectable()
export class LoggingEmailChannel implements NotificationChannelPort {
  readonly key = 'email';
  readonly providerVerified = false;
  private readonly logger = new Logger('EmailChannel');

  constructor(private readonly recipients: RecipientResolverPort) {}

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const { email } = await this.recipients.resolve(request.userId);
    if (!email) {
      return { delivered: false, errorCode: 'no_email_on_file', retryable: false };
    }

    this.logger.log(
      `[SIMULATED EMAIL] notification=${request.notificationId} template=${request.templateKey} subject_len=${request.rendered.subject.length}`,
    );
    return { delivered: true };
  }
}

/**
 * A channel that always fails, for exercising the retry and dead-letter paths.
 *
 * Registered ONLY by tests. It exists in the source tree rather than in a test
 * file because the retry machinery it exercises is the part most likely to be
 * quietly broken -- and a fake that lives beside the real channels stays in
 * step with the port when the port changes.
 */
export class AlwaysFailingChannel implements NotificationChannelPort {
  readonly providerVerified = false;
  constructor(
    readonly key: string,
    private readonly retryable: boolean,
    private readonly errorCode = 'simulated_failure',
  ) {}

  async send(): Promise<DeliveryResult> {
    return { delivered: false, errorCode: this.errorCode, retryable: this.retryable };
  }
}
