import { Global, Module } from '@nestjs/common';

import { ERROR_REPORTER, ErrorReporterPort, HttpErrorReporter, LoggingErrorReporter, httpErrorReporterConfigFromEnv } from './error-reporter';
import { HttpMetricsMiddleware } from './http-metrics.middleware';
import { MetricsRegistry, registerPlatformMetrics } from './metrics';

/**
 * Observability wiring (`OPS-03`, `OPS-04`).
 *
 * `@Global()`, for the reason `AuditModule` records for itself: this is
 * infrastructure several domains reference, and requiring every module that
 * wants to count something to import it would mean the ones that should count
 * something quietly do not.
 *
 * The error reporter is chosen from the ENVIRONMENT at boot rather than
 * injected by the composition root, exactly as `SMS_PROVIDER` is: there is no
 * code path that selects a backend, which is what makes selecting one a
 * configuration change. Unconfigured it falls back to `LoggingErrorReporter`,
 * and the fallback is VISIBLE -- `reportsExternally` becomes false and the
 * readiness endpoint says so, so a deployment that believes it is reporting
 * errors and is not cannot look like one that is.
 */
@Global()
@Module({
  providers: [
    {
      provide: MetricsRegistry,
      useFactory: (): MetricsRegistry => {
        const registry = new MetricsRegistry();
        registerPlatformMetrics(registry);
        return registry;
      },
    },
    HttpMetricsMiddleware,
    {
      provide: ERROR_REPORTER,
      useFactory: (): ErrorReporterPort => {
        const config = httpErrorReporterConfigFromEnv(process.env);
        return config ? new HttpErrorReporter(config) : new LoggingErrorReporter();
      },
    },
  ],
  exports: [MetricsRegistry, HttpMetricsMiddleware, ERROR_REPORTER],
})
export class ObservabilityModule {}
