import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { FINANCIAL_DATA_SOURCE } from '@beauclick/financial';
import { MediaService } from '@beauclick/media';
import { PaymentProviderRegistry, SANDBOX_PROVIDER_KEY } from '@beauclick/payment';
import { SEARCH_ENGINE, SearchEnginePort } from '@beauclick/search';
import { SMS_PROVIDER, SmsProvider } from '@beauclick/notification';

import { productionConfigurationErrors } from '../config/env.validation';
import {
  DependencyName,
  DependencyReadiness,
  EXTERNAL_VERIFICATION_LEDGER,
  REQUIRED_FOR_TRAFFIC,
  ReadinessState,
  allDependenciesReal,
  configurationVerdict,
  ConfigurationVerdict,
  externalEnablementComplete,
  overallReadiness,
} from './readiness';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  timestamp: string;
  dependencies: DependencyReadiness[];
  /**
   * Whether this process's configuration would satisfy every production rule.
   *
   * A BOOLEAN in production, with the reasons withheld. The reasons name
   * variables and rules, which is exactly the shape of a configuration map an
   * attacker would like -- and this endpoint is public and unauthenticated,
   * because an orchestrator's readiness probe carries no session. Outside
   * production the reasons are included, because that is where they are useful
   * and where there is nothing to protect.
   */
  configuration: ConfigurationVerdict;
  /**
   * The honest summary. Both are false on every deployment until the External
   * Enablement Gate is executed, and neither can be made true by code.
   */
  milestone: {
    allDependenciesReal: boolean;
    externalEnablementComplete: boolean;
  };
}

/**
 * Builds the readiness report.
 *
 * ## What this never emits
 *
 * No hostname, URL, bucket name, region, credential, provider endpoint, or
 * connection string appears in the output, in any environment. Every field is
 * an enum from `readiness.ts`, a boolean, or a gap id from a fixed set.
 *
 * That is a hard rule rather than a preference, because of where this endpoint
 * sits: it is `@Public()` and exempt from rate limiting -- an orchestrator's
 * probe carries no session and must never be throttled out of rotation -- so
 * it is reachable by anyone, unauthenticated, at any rate. A field that named
 * the search cluster's host or the object-storage endpoint would be a free
 * infrastructure map. `readiness.spec.ts` asserts the rule by serialising a
 * report built from deliberately secret-looking configuration and searching
 * the JSON for it.
 *
 * ## Why probes are selective
 *
 * The two same-cluster dependencies are probed with `SELECT 1` on every call:
 * cheap, and their state genuinely changes minute to minute. Search is pinged
 * because the port already offers one and the degraded path depends on it.
 * Object storage and the payment gateway are NOT probed -- one is a network
 * round trip to a bucket and the other is a request to a bank, on an endpoint
 * that may be polled every few seconds by several orchestrators at once. They
 * report `configured`, which is the truthful weaker claim.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly media: MediaService,
    @Optional() @Inject(FINANCIAL_DATA_SOURCE) private readonly financialDataSource?: DataSource,
    @Optional() @Inject(SEARCH_ENGINE) private readonly search?: SearchEnginePort,
    @Optional() private readonly payments?: PaymentProviderRegistry,
    @Optional() @Inject(SMS_PROVIDER) private readonly sms?: SmsProvider,
  ) {}

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  async report(): Promise<ReadinessReport> {
    const dependencies = await Promise.all([
      this.probeSql('database', this.dataSource),
      this.probeSql('ledger', this.financialDataSource),
      this.probeSearch(),
      this.describeStorage(),
      this.describePayment(),
      this.describeSms(),
      this.describeThrottleStore(),
    ]);

    const problems = productionConfigurationErrors(collectEnv(this.config));

    return {
      status: overallReadiness(dependencies),
      timestamp: new Date().toISOString(),
      dependencies,
      configuration: configurationVerdict(this.isProduction, problems),
      milestone: {
        allDependenciesReal: allDependenciesReal(dependencies),
        externalEnablementComplete: externalEnablementComplete(),
      },
    };
  }

  private describe(name: DependencyName, state: ReadinessState): DependencyReadiness {
    const ledger = EXTERNAL_VERIFICATION_LEDGER[name];
    return {
      name,
      state,
      productionVerified: ledger.verified,
      blockedBy: ledger.verified ? null : ledger.gap,
      required: REQUIRED_FOR_TRAFFIC[name],
    };
  }

  private async probeSql(name: DependencyName, dataSource?: DataSource): Promise<DependencyReadiness> {
    if (!dataSource) return this.describe(name, 'not_configured');
    try {
      await dataSource.query('SELECT 1');
      return this.describe(name, 'reachable');
    } catch {
      // The error is deliberately not surfaced: a connection error message
      // contains the host, port, database, and role.
      return this.describe(name, 'unreachable');
    }
  }

  private async probeSearch(): Promise<DependencyReadiness> {
    // The engine binding is decided by OPENSEARCH_URL at boot
    // (`SearchModule`), so its presence is what distinguishes a real cluster
    // from the in-process fake -- and the fake would answer `ping()` happily,
    // which is exactly how a simulated dependency passes for a real one.
    const configured = (this.config.get<string>('OPENSEARCH_URL') ?? '').trim() !== '';
    if (!configured) return this.describe('search', 'simulated');
    if (!this.search) return this.describe('search', 'not_configured');
    try {
      return this.describe('search', (await this.search.ping()) ? 'reachable' : 'unreachable');
    } catch {
      return this.describe('search', 'unreachable');
    }
  }

  private describeStorage(): DependencyReadiness {
    const driver = this.media.describeDriver();
    // `durable` is the driver's own claim about whether what it writes
    // survives the container. The local driver reports false.
    return this.describe('storage', driver.durable ? 'configured' : 'simulated');
  }

  private describePayment(): DependencyReadiness {
    if (!this.payments) return this.describe('payment', 'not_configured');
    const enabled = this.payments.enabledKeys();
    if (enabled.length === 0) return this.describe('payment', 'not_configured');
    // Any enabled gateway that is the sandbox makes this a SIMULATED payment
    // surface, whatever else is registered alongside it. This is the report
    // half of the two-condition production gate: that gate stops a sandbox
    // taking real money, and this stops a sandbox being mistaken for a bank.
    if (enabled.includes(SANDBOX_PROVIDER_KEY)) return this.describe('payment', 'simulated');
    return this.describe('payment', 'configured');
  }

  private describeSms(): DependencyReadiness {
    if (!this.sms) return this.describe('sms', 'not_configured');
    // `deliversExternally` is the provider's own statement about whether bytes
    // leave the building. `NullSmsProvider` succeeds and sends nothing, which
    // is right for development and must never look like delivery.
    return this.describe('sms', this.sms.deliversExternally ? 'configured' : 'simulated');
  }

  private describeThrottleStore(): DependencyReadiness {
    // `THROTTLE-STORE`. Storage is in-memory per process, which is CORRECT at
    // single-instance scale and silently wrong the moment a second instance
    // exists: the effective limit multiplies by instance count. No code here
    // can know the topology -- that is downstream of the hosting decision --
    // so the fact is reported and the judgement is left to whoever knows how
    // many instances are running.
    return this.describe('throttle_store', 'simulated');
  }
}

/**
 * The subset of the environment the production rules read.
 *
 * Enumerated rather than passing `process.env` wholesale, so this cannot
 * become a path by which an unrelated variable reaches a code path that
 * formats messages. The list mirrors `env.validation.ts`; a rule reading a
 * variable absent here would see it as unset, which fails CLOSED (reported as
 * a problem) rather than open.
 */
const VALIDATED_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'FINANCIAL_DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'OTP_HMAC_SECRET',
  'MEDIA_UPLOAD_TOKEN_SECRET',
  'MEDIA_DOWNLOAD_TOKEN_SECRET',
  'MEDIA_STORAGE_DRIVER',
  'MEDIA_ALLOW_LOCAL_DRIVER_IN_PRODUCTION',
  'MEDIA_S3_ACCESS_KEY_ID',
  'MEDIA_S3_SECRET_ACCESS_KEY',
  'MEDIA_S3_ENDPOINT',
  'MEDIA_S3_BUCKET',
  'SMS_HTTP_AUTH_VALUE',
  'PUBLIC_API_BASE_URL',
  'PUBLIC_WEB_BASE_URL',
  'CORS_ALLOWED_ORIGINS',
  'OPENSEARCH_URL',
  'PAYMENT_ENVIRONMENT',
  'PAYMENT_DEFAULT_PROVIDER',
  'DEV_QA_LOGIN',
  'DISABLE_BACKGROUND_SWEEPS',
] as const;

function collectEnv(config: ConfigService): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  for (const key of VALIDATED_KEYS) {
    const value = config.get<string>(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}
