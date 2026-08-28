/**
 * The SMS provider sub-port (`GAP-11`).
 *
 * WHY A SECOND PORT UNDER `NotificationChannelPort` RATHER THAN MORE CHANNELS.
 * The channel decides WHAT to send and how to classify a failure -- recipient
 * lookup, missing-number handling, the retryable/permanent split. A provider
 * decides only HOW the bytes leave the building. Collapsing the two, which is
 * what "add a KavenegarChannel" would do, means every future vendor
 * re-implements the recipient lookup and the failure taxonomy, and the second
 * one gets it subtly differently.
 *
 * WHAT THIS DOES AND DOES NOT CLOSE. `GAP-11` records that V2's SMS adapters
 * "have never been exercised against a real external API in any environment",
 * and that is still true: no Iranian SMS vendor has been selected
 * (`V3.1_PRODUCT_ROADMAP.md` §12) and no credentials exist anywhere this
 * project has run. What this port and `HttpSmsProvider` close is the CODE side
 * -- request construction, timeout, response classification, redaction, and
 * the retry contract, all exercised against a real HTTP server in the suite.
 * What remains open is an endpoint, a credential, and one live send. That is
 * deployment configuration, and `deliversExternally` is what stops it being
 * mistaken for done.
 *
 * The alternative -- shipping a named vendor adapter written from
 * documentation -- was rejected for the reason `NotificationChannelPort`
 * already records about payment gateways: an unexercised adapter is a
 * liability rather than an asset, because it looks finished.
 */

export type SmsSendOutcome =
  | { accepted: true; providerMessageId: string | null }
  | {
      /** A stable code, never the provider's raw message -- a gateway error string routinely embeds the recipient's number. */
      accepted: false;
      errorCode: string;
      /** Whether retrying could plausibly succeed. Only the provider knows that a 401 will not improve with time. */
      retryable: boolean;
    };

export interface SmsProvider {
  readonly key: string;

  /**
   * Whether this provider actually transmits to an external network.
   *
   * Surfaced through the channel's `providerVerified` and onto `/health`. A
   * provider that logs must never be indistinguishable from one that sends:
   * V2 shipped a "local development only" payment stand-in whose status was UI
   * text with no mechanism behind it, and Phase 2 found it.
   */
  readonly deliversExternally: boolean;

  /**
   * `to` is E.164; `text` is the rendered short form.
   *
   * Neither may be logged by an implementation. That is not a style rule: an
   * SMS log line containing a phone number is a personal-data leak into every
   * aggregator that ever ingests it, and the body of an OTP message is a
   * credential.
   */
  send(to: string, text: string): Promise<SmsSendOutcome>;
}

export const SMS_PROVIDER = Symbol('BEAUCLICK_SMS_PROVIDER');

/**
 * The provider used when none is configured.
 *
 * It reports `deliversExternally: false` and succeeds, which is the correct
 * pair: the platform's own delivery machinery worked, and nothing left the
 * building. Reporting failure instead would fill the dead-letter queue with
 * messages that were never meant to be sent, and would make an unconfigured
 * development environment indistinguishable from a broken gateway.
 */
export class NullSmsProvider implements SmsProvider {
  readonly key = 'null';
  readonly deliversExternally = false;

  async send(): Promise<SmsSendOutcome> {
    return { accepted: true, providerMessageId: null };
  }
}
