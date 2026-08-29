import { Logger } from '@nestjs/common';

import { redact, redactText } from './redact';

/**
 * The error-reporting port (`OPS-04`).
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §7 names Sentry, and the roadmap lists error
 * tracking as required for production: "cheap, and the first production
 * incident is the wrong time to add it".
 *
 * ## Why a port and not the Sentry SDK
 *
 * Because binding a vendor SDK here would settle, in code, a question this
 * phase is explicitly not allowed to settle on the owner's behalf -- and
 * because it would not close `OPS-04` anyway. What closes `OPS-04` is a real
 * DSN, in a real deployment, with a real production error arriving in a real
 * dashboard. All three are external. Installing an SDK now buys a dependency
 * tree (the current Sentry Node SDK carries the whole OpenTelemetry stack) in
 * exchange for a green checkbox that would still be waiting on the same three
 * things.
 *
 * What CAN be settled now, and is:
 *
 *  - **where** errors are captured from -- one filter, not scattered try/catch;
 *  - **what** an error report contains, and what it must never contain;
 *  - **what happens when the backend is unavailable**, which is the part that
 *    is usually got wrong and is impossible to fix during the incident it
 *    matters in;
 *  - a default that is honest about transmitting nothing.
 *
 * This mirrors exactly what `SmsProvider` / `HttpSmsProvider` did for
 * `GAP-11`: the port, the failure taxonomy, the timeout, and the redaction are
 * the code half; the vendor and the credential are the external half, and
 * `reportsExternally` is what stops the two being confused.
 *
 * ## `reportsExternally` is the whole point of the interface
 *
 * A logging reporter and a transmitting one must never be indistinguishable.
 * This is the third time this codebase has needed that distinction --
 * `NotificationChannelPort.providerVerified`, `SmsProvider.deliversExternally`,
 * `MediaService.describeDriver().durable` -- and the reason is always the same
 * one: V2 shipped a "local development only" payment stand-in whose status was
 * a sentence in the UI with no mechanism behind it.
 */
export interface ErrorReport {
  /** The exception, already redacted by `capture`. */
  readonly error: { name: string; message: string; stack?: string };
  /** `error` for a real fault, `warning` for a handled one worth knowing about. */
  readonly level: 'error' | 'warning';
  /** Ties the report to every log line and outbox row from the same request. */
  readonly correlationId: string | null;
  /** Route template, never the raw path -- a path carries ids. */
  readonly route: string | null;
  readonly method: string | null;
  readonly statusCode: number | null;
  /**
   * The user this happened to, as an ID ONLY.
   *
   * Never a phone number, name, or email. An error tracker is a third-party
   * system holding data indefinitely; an opaque id there can be joined to a
   * person by someone with database access, which is the correct amount of
   * friction. A phone number there is a personal-data export nobody approved.
   */
  readonly userId: string | null;
  /** Anything else, redacted. */
  readonly context: Record<string, unknown>;
}

export interface ErrorReporterPort {
  readonly key: string;
  /**
   * Whether reports actually leave the process.
   *
   * Surfaced on the readiness endpoint. `false` means errors are logged and
   * nothing more -- correct for development, and a launch blocker in
   * production, which is a judgement for whoever reads the report rather than
   * a reason to refuse to boot.
   */
  readonly reportsExternally: boolean;

  /**
   * Records an error.
   *
   * **Must never throw and must never reject.** It is called from the global
   * exception filter, which is already handling a failure; an error reporter
   * that fails there turns a 500 with a Persian message into an unhandled
   * rejection and, in the worst case, takes the process down. The one thing an
   * observability backend must not do is amplify an outage.
   */
  capture(report: ErrorReport): Promise<void>;
}

export const ERROR_REPORTER = Symbol('BEAUCLICK_ERROR_REPORTER');

/**
 * The default: logs, transmits nothing, says so.
 *
 * Reporting failure instead would be the wrong pair -- the platform's own
 * error handling worked, and nothing left the building. This is the same
 * reasoning `NullSmsProvider` records.
 */
export class LoggingErrorReporter implements ErrorReporterPort {
  readonly key = 'logging';
  readonly reportsExternally = false;

  private readonly logger = new Logger('ErrorReporter');

  async capture(report: ErrorReport): Promise<void> {
    this.logger.error({
      action: 'error.captured',
      correlation: report.correlationId,
      route: report.route,
      method: report.method,
      statusCode: report.statusCode,
      name: report.error.name,
      message: report.error.message,
    });
  }
}

/**
 * Everything a deployment must supply to make error reporting real.
 *
 * Describes a REQUEST rather than a vendor, exactly as `HttpSmsProviderConfig`
 * does and for the same reason: an endpoint, an auth header, and a timeout are
 * what differ between collectors, and making those configuration means
 * selecting one is a deployment change rather than a code change.
 *
 * **This is not a Sentry adapter.** Sentry's ingestion protocol is an envelope
 * format this does not speak. What this delivers to is any collector that
 * accepts a JSON POST -- which several do, including forwarders that then
 * speak Sentry's protocol on the other side. `OPS-04` remains open either way,
 * because it asks for real production errors arriving at the selected backend,
 * and no backend has been selected.
 */
export interface HttpErrorReporterConfig {
  readonly endpoint: string;
  readonly authHeader: string;
  readonly authValue: string;
  readonly timeoutMs: number;
  /** Names the deployment in the collector, e.g. `production` / `staging`. */
  readonly environment: string;
  readonly release: string | null;
}

export function httpErrorReporterConfigFromEnv(env: NodeJS.ProcessEnv): HttpErrorReporterConfig | null {
  const endpoint = env.ERROR_REPORTER_ENDPOINT?.trim();
  const authValue = env.ERROR_REPORTER_AUTH_VALUE?.trim();
  // Partial configuration is treated as none. An endpoint with no credential
  // produces a 401 on every error report, and an operator would be debugging
  // the reporter during the incident the reporter exists to explain.
  if (!endpoint || !authValue) return null;

  if (!endpoint.startsWith('https://')) {
    // An error report carries stack traces, route templates, and user ids.
    // Over plaintext that is handed to anything on the path.
    throw new Error('ERROR_REPORTER_ENDPOINT must be https. Error reports carry stack traces and user identifiers.');
  }

  const timeoutMs = Number(env.ERROR_REPORTER_TIMEOUT_MS ?? 3000);
  return {
    endpoint,
    authHeader: env.ERROR_REPORTER_AUTH_HEADER?.trim() || 'Authorization',
    authValue,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000,
    environment: env.NODE_ENV ?? 'development',
    release: env.RELEASE_VERSION?.trim() || null,
  };
}

/**
 * Posts redacted error reports to a configured collector.
 *
 * Three properties, all of them about not making an outage worse:
 *
 *  1. **A timeout.** Mandatory, not defensive. This runs inside the exception
 *     filter, on a request a browser is waiting on. A collector that accepts
 *     the connection and never answers would hold every failing request open,
 *     turning a 500 into a hang, and a hang into an exhausted connection pool.
 *  2. **Never throws.** Every failure path returns. See the port's docblock.
 *  3. **Never retried.** A collector that is down is down for every request at
 *     once, and a retry storm aimed at a struggling service during an incident
 *     is how a partial outage becomes a total one. A dropped error report is a
 *     gap in a dashboard; the log line is still there.
 */
export class HttpErrorReporter implements ErrorReporterPort {
  readonly key = 'http';
  readonly reportsExternally = true;

  private readonly logger = new Logger('ErrorReporter');

  constructor(private readonly config: HttpErrorReporterConfig) {}

  async capture(report: ErrorReport): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [this.config.authHeader]: this.config.authValue,
        },
        // Redacted a SECOND time here, deliberately. The filter redacts on the
        // way in; this is the boundary where bytes leave the building, and the
        // cost of running it twice is nothing next to the cost of a caller
        // that constructed a report by another route.
        body: JSON.stringify({
          environment: this.config.environment,
          release: this.config.release,
          correlationId: report.correlationId,
          level: report.level,
          route: report.route,
          method: report.method,
          statusCode: report.statusCode,
          userId: report.userId,
          error: {
            name: report.error.name,
            message: redactText(report.error.message),
            stack: report.error.stack ? redactText(report.error.stack) : undefined,
          },
          context: redact(report.context),
        }),
        signal: abort.signal,
      });

      if (!response.ok) {
        // The status only. A collector's error BODY frequently quotes the
        // payload back, and logging that would defeat the redaction above.
        this.logger.warn(`Error reporter rejected a report with HTTP ${response.status}`);
      }
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError';
      this.logger.warn(`Error reporter unreachable: ${aborted ? 'timeout' : (error as Error)?.message ?? 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
