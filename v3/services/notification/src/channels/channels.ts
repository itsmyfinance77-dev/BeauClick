import { Injectable, Logger } from '@nestjs/common';
import { DeliveryRequest, DeliveryResult, NotificationChannelPort } from './notification-channel.port';
import { SmsProvider } from './sms/sms-provider.port';

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
 * SMS delivery, through the `SmsProvider` sub-port.
 *
 * WHAT CHANGED IN PHASE E AND WHAT DID NOT. This class used to log and return
 * success unconditionally. It now delegates to a configured provider, and
 * reports `providerVerified` from that provider rather than from a hardcoded
 * `false` -- so a deployment that has wired a real gateway stops being
 * described on `/health` as one that has not.
 *
 * What did NOT change is the honesty rule this file was written around: with
 * no provider configured the channel gets `NullSmsProvider`,
 * `providerVerified` is `false`, and nothing leaves the building. `GAP-11`
 * stays open until a real vendor endpoint has been exercised -- see
 * `sms-provider.port.ts` for exactly which half of it this closes.
 *
 * Everything the channel already owned it still owns: the recipient lookup,
 * the permanent-vs-transient classification, and the guarantee that neither
 * the number nor the message body reaches a persisted field or a log line.
 */
@Injectable()
export class SmsChannel implements NotificationChannelPort {
  readonly key = 'sms';
  private readonly logger = new Logger('SmsChannel');

  constructor(
    private readonly recipients: RecipientResolverPort,
    private readonly provider: SmsProvider,
  ) {}

  /**
   * True only when the configured provider actually transmits.
   *
   * Derived rather than declared, so the two cannot drift: there is no way to
   * configure a real gateway and leave the health surface saying otherwise,
   * and no way to claim verification without a provider that transmits.
   */
  get providerVerified(): boolean {
    return this.provider.deliversExternally;
  }

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    const { phone } = await this.recipients.resolve(request.userId);
    if (!phone) {
      // Permanent: a customer with no phone number on file will not acquire
      // one because we retried. Retrying this forever is how a dead-letter
      // queue fills with messages that were never deliverable.
      return { delivered: false, errorCode: 'no_phone_on_file', retryable: false };
    }

    const outcome = await this.provider.send(phone, request.rendered.short);
    if (outcome.accepted) {
      // The number is deliberately NOT logged. An SMS log line containing a
      // phone number is a personal-data leak into every log aggregator that
      // ever ingests it -- and with a real provider configured, the body is a
      // one-time login code.
      this.logger.log(
        `SMS accepted by provider=${this.provider.key} notification=${request.notificationId} template=${request.templateKey} chars=${request.rendered.short.length}`,
      );
      return { delivered: true };
    }

    return { delivered: false, errorCode: outcome.errorCode, retryable: outcome.retryable };
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
