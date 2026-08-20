import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '@beauclick/http';

import { PAYMENT_PROVIDERS, PaymentProvider } from './payment-provider.interface';

export class PaymentProviderUnavailableException extends DomainException {
  constructor(key: string) {
    super(
      'PAYMENT_PROVIDER_UNAVAILABLE',
      'درگاه پرداخت در دسترس نیست. لطفاً بعداً دوباره تلاش کنید.',
      HttpStatus.SERVICE_UNAVAILABLE,
      { providerKey: key },
    );
  }
}

/** A provider may opt into an environment gate by implementing this. Absent means "always enabled". */
export interface GatedPaymentProvider extends PaymentProvider {
  isEnabled(): boolean;
}

function isGated(provider: PaymentProvider): provider is GatedPaymentProvider {
  return typeof (provider as GatedPaymentProvider).isEnabled === 'function';
}

/**
 * Resolves a provider key to an adapter, and decides the default gateway.
 *
 * The whole point of ADR-006's abstraction lives here: nothing else in V3
 * ever names a concrete gateway. Adding ZarinPal (or any other) means
 * registering one more adapter under `PAYMENT_PROVIDERS` -- commerce,
 * booking, financial, and every controller are untouched.
 *
 * **Fails closed.** An unknown key, a disabled provider, or no providers at
 * all produce a Persian 503, never a silent fallback to some other gateway.
 * Silently substituting a payment provider is the kind of "helpful" default
 * that charges a customer through a channel nobody chose.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly logger = new Logger('PaymentProviderRegistry');
  private readonly byKey = new Map<string, PaymentProvider>();

  constructor(
    @Optional() @Inject(PAYMENT_PROVIDERS) providers: PaymentProvider[] = [],
    private readonly config: ConfigService,
  ) {
    for (const provider of providers ?? []) {
      if (this.byKey.has(provider.key)) {
        throw new Error(`Two payment providers registered under the same key "${provider.key}"`);
      }
      this.byKey.set(provider.key, provider);
    }
    this.logger.log(`Registered payment providers: ${[...this.byKey.keys()].join(', ') || '(none)'}`);
  }

  /**
   * The gateway used when a caller does not name one.
   *
   * `PAYMENT_DEFAULT_PROVIDER` is required whenever more than one provider
   * is registered -- deliberately not "the first one wins", which would make
   * the production gateway depend on module import order.
   */
  defaultProviderKey(): string {
    const configured = this.config.get<string>('PAYMENT_DEFAULT_PROVIDER');
    if (configured) return configured;

    const enabled = this.enabledKeys();
    if (enabled.length === 1) return enabled[0];
    throw new PaymentProviderUnavailableException(configured ?? '(unset)');
  }

  get(key: string): PaymentProvider {
    const provider = this.byKey.get(key);
    if (!provider) throw new PaymentProviderUnavailableException(key);
    if (isGated(provider) && !provider.isEnabled()) {
      this.logger.warn(`Payment provider "${key}" is registered but disabled in this environment`);
      throw new PaymentProviderUnavailableException(key);
    }
    return provider;
  }

  enabledKeys(): string[] {
    return [...this.byKey.values()].filter((p) => !isGated(p) || p.isEnabled()).map((p) => p.key);
  }

  /** For a gateway picker in the UI. */
  describeEnabled(): { key: string; displayName: string; supportsAutomaticRefund: boolean }[] {
    return [...this.byKey.values()]
      .filter((p) => !isGated(p) || p.isEnabled())
      .map((p) => ({ key: p.key, displayName: p.displayName, supportsAutomaticRefund: p.supportsAutomaticRefund }));
  }
}
