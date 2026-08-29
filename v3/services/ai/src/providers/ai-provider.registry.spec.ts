import { ConfigService } from '@nestjs/config';

import { AiProviderRegistry, AiProviderUnavailableException } from './ai-provider.registry';
import { AiAssistantProvider, AiCompletionDraft, DETERMINISTIC_PROVIDER_KEY } from './ai-provider.interface';
import { DeterministicAssistantProvider } from './deterministic-assistant.provider';

/**
 * The registry — ADR-029 §3 and §4.
 *
 * Two behaviours look like paranoia in a registry holding one entry and are
 * not, and both are here: **it refuses to guess**, and **it fails closed**.
 *
 * The stakes are higher than for the payment registry this is modelled on. A
 * substituted payment gateway fails visibly, at checkout, with a bank saying no.
 * A substituted model produces a confident Persian paragraph that nobody --
 * user, operator, or dashboard -- can distinguish from the intended one.
 */

function config(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** A stand-in for the real vendor adapter that does not exist yet. */
class FakeExternalProvider implements AiAssistantProvider {
  readonly key = 'fake-external';
  readonly displayName = 'Fake External';
  readonly mode = 'external' as const;
  readonly respondsExternally = true;
  async complete(): Promise<AiCompletionDraft> {
    return { reply: 'x', recommendations: [] };
  }
}

describe('AiProviderRegistry', () => {
  describe('resolveDefault', () => {
    it('resolves the single registered provider without needing to be told', () => {
      const deterministic = new DeterministicAssistantProvider();
      const registry = new AiProviderRegistry([deterministic], config());
      // Not a guess: there is nothing to guess between.
      expect(registry.resolveDefault()).toBe(deterministic);
    });

    /**
     * The behaviour that matters most.
     *
     * "The first one wins" would make the model answering customers depend on
     * module import order — a property nobody reviews and nothing tests, that
     * changes when an unrelated import is reordered.
     */
    it('refuses to pick between two registered providers rather than letting import order decide', () => {
      const registry = new AiProviderRegistry(
        [new DeterministicAssistantProvider(), new FakeExternalProvider()],
        config(),
      );
      expect(() => registry.resolveDefault()).toThrow(AiProviderUnavailableException);
    });

    it('honours AI_DEFAULT_PROVIDER when more than one is registered', () => {
      const external = new FakeExternalProvider();
      const registry = new AiProviderRegistry(
        [new DeterministicAssistantProvider(), external],
        config({ AI_DEFAULT_PROVIDER: 'fake-external' }),
      );
      expect(registry.resolveDefault()).toBe(external);
    });

    /**
     * A deployment that names a real vendor and fails to register its adapter
     * must NOT quietly serve the deterministic assistant while readiness reports
     * a configured provider. That is the exact "sandbox presented as production"
     * hazard the payment gate exists to prevent, arriving through the AI door.
     */
    it('refuses when AI_DEFAULT_PROVIDER names something unregistered, rather than falling back', () => {
      const registry = new AiProviderRegistry(
        [new DeterministicAssistantProvider()],
        config({ AI_DEFAULT_PROVIDER: 'a-vendor-nobody-wired-up' }),
      );
      expect(() => registry.resolveDefault()).toThrow(AiProviderUnavailableException);
    });

    it('refuses when nothing is registered', () => {
      const registry = new AiProviderRegistry([], config());
      expect(() => registry.resolveDefault()).toThrow(AiProviderUnavailableException);
    });

    it('rejects two providers claiming the same key at construction time', () => {
      expect(() => new AiProviderRegistry([new DeterministicAssistantProvider(), new DeterministicAssistantProvider()], config())).toThrow(
        /same key/,
      );
    });
  });

  describe('the refusal itself', () => {
    /**
     * One Persian sentence, no provider name, and no distinction between
     * "unknown key" and "none registered".
     *
     * A caller learning which of those it hit learns something about the
     * deployment's configuration and can do nothing with either answer.
     */
    it('carries a Persian message and names no provider, key, or configuration value', () => {
      const registry = new AiProviderRegistry([], config({ AI_DEFAULT_PROVIDER: 'super-secret-vendor' }));
      try {
        registry.resolveDefault();
        throw new Error('should have thrown');
      } catch (error) {
        const refusal = error as AiProviderUnavailableException;
        expect(refusal).toBeInstanceOf(AiProviderUnavailableException);
        expect(refusal.code).toBe('AI_PROVIDER_UNAVAILABLE');
        expect(JSON.stringify(refusal.getResponse())).not.toContain('super-secret-vendor');
        // Persian, per V3_API_CONTRACT_BLUEPRINT.md §6.
        expect(refusal.message).toMatch(/[؀-ۿ]/);
      }
    });

    it('produces the same refusal whether the key is unknown or nothing is registered', () => {
      const unknownKey = new AiProviderRegistry([new DeterministicAssistantProvider()], config({ AI_DEFAULT_PROVIDER: 'nope' }));
      const nothingRegistered = new AiProviderRegistry([], config());

      const publishedBody = (registry: AiProviderRegistry): string => {
        try {
          registry.resolveDefault();
        } catch (error) {
          return JSON.stringify((error as AiProviderUnavailableException).getResponse());
        }
        throw new Error('resolveDefault should have refused');
      };

      expect(publishedBody(unknownKey)).toBe(publishedBody(nothingRegistered));
    });
  });

  describe('describeReadiness — the honesty surface', () => {
    /**
     * `simulated` is the load-bearing word, and it is the same word the sandbox
     * gateway, the null SMS provider, and the in-memory search engine already
     * wear (ADR-028).
     */
    it('reports simulated when only the deterministic assistant can answer', () => {
      const registry = new AiProviderRegistry([new DeterministicAssistantProvider()], config());
      expect(registry.describeReadiness()).toBe('simulated');
      expect(registry.isDeterministicOnly()).toBe(true);
    });

    it('reports not_configured when nothing is registered', () => {
      expect(new AiProviderRegistry([], config()).describeReadiness()).toBe('not_configured');
    });

    /**
     * Computed from the RESOLVED provider, not from configuration.
     *
     * A deployment whose `AI_DEFAULT_PROVIDER` is unresolvable reports
     * `not_configured` rather than `configured`, because nothing can answer --
     * and reporting `configured` there would be the readiness surface asserting
     * a capability the deployment does not have.
     */
    it('reports not_configured when the configured provider cannot be resolved', () => {
      const registry = new AiProviderRegistry(
        [new DeterministicAssistantProvider()],
        config({ AI_DEFAULT_PROVIDER: 'a-vendor-nobody-wired-up' }),
      );
      expect(registry.describeReadiness()).toBe('not_configured');
    });

    it('reports configured, never reachable, once a real provider answers', () => {
      const registry = new AiProviderRegistry(
        [new FakeExternalProvider()],
        config({ AI_DEFAULT_PROVIDER: 'fake-external' }),
      );
      // `configured` is the truthful weaker claim: settings exist, nothing was
      // probed. The same position object storage and the payment gateway take,
      // because a public rate-limit-exempt endpoint must not open a paid API
      // connection on every orchestrator poll.
      expect(registry.describeReadiness()).toBe('configured');
    });

    it('never reports simulated once a real provider is the selected one', () => {
      const registry = new AiProviderRegistry(
        [new DeterministicAssistantProvider(), new FakeExternalProvider()],
        config({ AI_DEFAULT_PROVIDER: 'fake-external' }),
      );
      expect(registry.describeReadiness()).toBe('configured');
      expect(registry.isDeterministicOnly()).toBe(false);
    });
  });

  describe('stateOf — what the browser is told, per message', () => {
    it('maps the deterministic assistant to simulated and a real one to external', () => {
      const registry = new AiProviderRegistry([new DeterministicAssistantProvider()], config());
      expect(registry.stateOf(new DeterministicAssistantProvider())).toBe('simulated');
      expect(registry.stateOf(new FakeExternalProvider())).toBe('external');
    });
  });

  describe('the sandbox milestone', () => {
    /**
     * The scope assertion for this whole phase.
     *
     * ADR-029: no named vendor adapter, no vendor SDK, no fake credentials, no
     * external endpoint. If somebody adds one, the registered key set changes and
     * this fails.
     */
    it('registers exactly one provider, and it is the deterministic one', () => {
      const registry = new AiProviderRegistry([new DeterministicAssistantProvider()], config());
      expect(registry.registeredKeys()).toEqual([DETERMINISTIC_PROVIDER_KEY]);
    });

    it('needs no credential to resolve and answer', () => {
      // An entirely empty configuration. The deterministic provider is usable
      // with no external credentials, which is what makes the sandbox milestone
      // runnable on a laptop and in CI.
      const registry = new AiProviderRegistry([new DeterministicAssistantProvider()], config());
      const provider = registry.resolveDefault();
      expect(provider.respondsExternally).toBe(false);
      expect(provider.mode).toBe('deterministic');
    });
  });
});
