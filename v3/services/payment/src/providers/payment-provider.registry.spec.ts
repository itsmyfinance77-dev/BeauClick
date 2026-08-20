import { ConfigService } from '@nestjs/config';
import { PaymentProviderRegistry, PaymentProviderUnavailableException } from './payment-provider.registry';
import { PaymentProvider } from './payment-provider.interface';

function stubConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function fakeProvider(key: string, enabled?: boolean): PaymentProvider {
  const base: PaymentProvider = {
    key,
    displayName: key,
    supportsAutomaticRefund: true,
    initiate: async () => ({ providerReference: 'x', redirectUrl: 'https://x' }),
    verify: async () => ({ outcome: 'failed', paidAmountToman: null, providerTransactionId: null, failureCode: null }),
    refund: async () => ({ outcome: 'failed', providerRefundReference: null, failureCode: null }),
  };
  return enabled === undefined ? base : Object.assign(base, { isEnabled: () => enabled });
}

/**
 * The registry is the whole point of ADR-006's abstraction: nothing else in
 * V3 ever names a concrete gateway. Its most important property is that it
 * FAILS CLOSED -- silently substituting a payment provider would charge a
 * customer through a channel nobody chose.
 */
describe('PaymentProviderRegistry', () => {
  it('resolves a registered provider by key', () => {
    const registry = new PaymentProviderRegistry([fakeProvider('mock')], stubConfig());
    expect(registry.get('mock').key).toBe('mock');
  });

  it('refuses an unknown key rather than falling back to another gateway', () => {
    const registry = new PaymentProviderRegistry([fakeProvider('mock')], stubConfig());
    expect(() => registry.get('zarinpal')).toThrow(PaymentProviderUnavailableException);
  });

  it('refuses a registered but DISABLED provider', () => {
    const registry = new PaymentProviderRegistry([fakeProvider('mock', false)], stubConfig());
    expect(() => registry.get('mock')).toThrow(PaymentProviderUnavailableException);
    expect(registry.enabledKeys()).toEqual([]);
  });

  it('rejects two providers registered under the same key, at construction', () => {
    expect(() => new PaymentProviderRegistry([fakeProvider('mock'), fakeProvider('mock')], stubConfig())).toThrow(
      /same key/,
    );
  });

  it('uses the single enabled provider as the default when only one exists', () => {
    const registry = new PaymentProviderRegistry([fakeProvider('mock')], stubConfig());
    expect(registry.defaultProviderKey()).toBe('mock');
  });

  it('REQUIRES an explicit default once more than one provider is registered', () => {
    // Deliberately not "the first one wins": that would make the production
    // gateway depend on module import order.
    const registry = new PaymentProviderRegistry([fakeProvider('mock'), fakeProvider('zarinpal')], stubConfig());
    expect(() => registry.defaultProviderKey()).toThrow(PaymentProviderUnavailableException);
  });

  it('honours the configured default', () => {
    const registry = new PaymentProviderRegistry(
      [fakeProvider('mock'), fakeProvider('zarinpal')],
      stubConfig({ PAYMENT_DEFAULT_PROVIDER: 'zarinpal' }),
    );
    expect(registry.defaultProviderKey()).toBe('zarinpal');
  });

  it('fails closed when nothing is registered at all', () => {
    const registry = new PaymentProviderRegistry([], stubConfig());
    expect(() => registry.defaultProviderKey()).toThrow(PaymentProviderUnavailableException);
    expect(registry.enabledKeys()).toEqual([]);
  });

  it('describes only enabled providers for a gateway picker', () => {
    const registry = new PaymentProviderRegistry(
      [fakeProvider('mock', true), fakeProvider('offline', false)],
      stubConfig(),
    );
    expect(registry.describeEnabled().map((p) => p.key)).toEqual(['mock']);
  });

  it('reports a Persian, non-technical message when a gateway is unavailable', () => {
    const registry = new PaymentProviderRegistry([], stubConfig());
    try {
      registry.get('nope');
      throw new Error('should have thrown');
    } catch (err) {
      const response = (err as { getResponse(): { code: string; message: string } }).getResponse();
      expect(response.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      // No English, no gateway internals leaked to the customer.
      expect(response.message).toMatch(/درگاه پرداخت/);
    }
  });
});
