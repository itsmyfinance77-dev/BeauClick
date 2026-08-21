/**
 * The delivery-channel abstraction.
 *
 * Modelled directly on Phase 2's `PaymentProvider` registry, and for the same
 * reason: the honest position on an unintegrated external provider is a
 * working abstraction plus an explicit statement that no real adapter exists
 * — not a plausible-looking adapter whose field semantics have never been
 * exercised against the live API.
 *
 * `GAP-11` is explicit that V2's SMS and email adapters "have never been
 * exercised against a real external API in any environment". That is still
 * true in this environment, and this phase does not pretend otherwise: the
 * in-app channel is genuinely implemented and genuinely verified, while email
 * and SMS ship a real abstraction with a logging provider behind it and
 * `providerVerified: false` reported by the health surface.
 */

export interface DeliveryRequest {
  notificationId: string;
  userId: string;
  channel: string;
  templateKey: string;
  /** Rendered at dispatch time from the stored variables. Never persisted. */
  rendered: RenderedMessage;
  deepLink: string | null;
}

export interface RenderedMessage {
  subject: string;
  body: string;
  /** A shorter variant for length-limited channels. */
  short: string;
}

export interface DeliveryResult {
  delivered: boolean;
  /**
   * A stable, enumerable code -- never the provider's raw message.
   *
   * A gateway's error string routinely embeds the recipient's phone number or
   * email address, and that string would otherwise flow into the notification
   * row, the NotificationFailed event, and every log line downstream. The code
   * carries the operational meaning without the payload.
   */
  errorCode?: string;
  /**
   * Whether retrying could plausibly succeed.
   *
   * The channel decides this, not the caller: only the channel knows that "no
   * phone number on file" will never improve with time while "provider
   * timed out" might. V2 hard-coded a single transient-error list in the
   * service, which meant every new channel silently inherited another
   * channel's retry semantics.
   */
  retryable?: boolean;
}

export interface NotificationChannelPort {
  readonly key: string;
  /**
   * Whether this channel talks to a genuinely integrated external provider.
   *
   * Reported by the admin surface. A channel that quietly logs instead of
   * sending must never be indistinguishable from one that delivers -- V2
   * shipped a "local development only" payment stand-in whose status was UI
   * text with no mechanism behind it, and Phase 2 found it.
   */
  readonly providerVerified: boolean;
  send(request: DeliveryRequest): Promise<DeliveryResult>;
}

export const NOTIFICATION_CHANNELS_TOKEN = Symbol('BEAUCLICK_NOTIFICATION_CHANNELS');
