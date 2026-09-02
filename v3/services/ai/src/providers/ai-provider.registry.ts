import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DomainException } from '@beauclick/http';
import type { AiProviderState } from '@beauclick/ai-contract';

import { AI_PROVIDERS, AiAssistantProvider, DETERMINISTIC_PROVIDER_KEY } from './ai-provider.interface';

/**
 * The one refusal this registry produces.
 *
 * A single Persian sentence with no provider name, no configuration value, and
 * no distinction between "unknown key" and "none registered" — a caller
 * learning which of those it hit learns something about the deployment's
 * configuration, and there is nothing they could do with either answer.
 */
export class AiProviderUnavailableException extends DomainException {
  constructor() {
    super(
      'AI_PROVIDER_UNAVAILABLE',
      'دستیار هوشمند در حال حاضر در دسترس نیست. لطفاً بعداً دوباره تلاش کنید.',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * Resolves a provider key to an adapter, and decides which one answers.
 *
 * Modelled directly on `PaymentProviderRegistry`, including the two behaviours
 * that look like paranoia in a registry holding one entry and are not:
 *
 * **It refuses to guess.** More than one registered provider with no
 * `AI_DEFAULT_PROVIDER` is a refusal, not "the first one wins". A first-one-wins
 * rule would make the model answering customers depend on module import order,
 * which is the same defect the payment registry exists to prevent for gateways
 * and is worse here — a payment gateway substitution fails visibly, and a model
 * substitution produces a confident paragraph nobody can tell apart.
 *
 * **It fails closed.** An unknown key, or an empty registry, produces a Persian
 * 503. There is no silent fallback to the deterministic provider, because that
 * is exactly the implicit substitution `F-03` records as V2's mistake: a user
 * cannot distinguish "the model is having a bad day" from "you are now talking
 * to a template", and neither can an operator reading a dashboard.
 *
 * The deterministic provider serves when it is the SELECTED provider, and at no
 * other time.
 */
@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger('AiProviderRegistry');
  private readonly byKey = new Map<string, AiAssistantProvider>();

  constructor(
    @Optional() @Inject(AI_PROVIDERS) providers: AiAssistantProvider[] = [],
    private readonly config: ConfigService,
  ) {
    for (const provider of providers ?? []) {
      if (this.byKey.has(provider.key)) {
        throw new Error(`Two AI providers registered under the same key "${provider.key}"`);
      }
      this.byKey.set(provider.key, provider);
    }
    // The keys, never a credential and never an endpoint. An operator needs to
    // know WHAT is registered; the log is not where they find out how.
    this.logger.log(`Registered AI providers: ${[...this.byKey.keys()].join(', ') || '(none)'}`);
  }

  registeredKeys(): string[] {
    return [...this.byKey.keys()];
  }

  /**
   * The provider that answers when a caller does not name one.
   *
   * `AI_DEFAULT_PROVIDER` is required whenever more than one is registered. With
   * exactly one, that one answers — which is not a guess, because there is
   * nothing to guess between.
   *
   * An `AI_DEFAULT_PROVIDER` naming something unregistered is a refusal, not a
   * fallback to whatever is there. A deployment that names a real vendor and
   * fails to register its adapter must NOT quietly serve the deterministic
   * assistant while readiness reports a configured provider (ADR-029 §4).
   */
  resolveDefault(): AiAssistantProvider {
    const configured = (this.config.get<string>('AI_DEFAULT_PROVIDER') ?? '').trim();

    if (configured !== '') {
      const provider = this.byKey.get(configured);
      if (!provider) {
        this.logger.error(
          `AI_DEFAULT_PROVIDER names "${configured}", which is not registered. Refusing rather than substituting another provider.`,
        );
        throw new AiProviderUnavailableException();
      }
      return provider;
    }

    const all = [...this.byKey.values()];
    if (all.length === 1) return all[0];

    this.logger.error(
      all.length === 0
        ? 'No AI provider is registered.'
        : `${all.length} AI providers are registered and AI_DEFAULT_PROVIDER is unset. Refusing to let import order decide which model answers customers.`,
    );
    throw new AiProviderUnavailableException();
  }

  /**
   * What the readiness surface reports (ADR-028's vocabulary, ADR-029 §4).
   *
   * Deliberately unflattering, and deliberately computed from the RESOLVED
   * provider rather than from configuration: a deployment whose
   * `AI_DEFAULT_PROVIDER` is unresolvable reports `not_configured`, not
   * `configured`, because nothing can answer.
   *
   * `simulated` is the load-bearing word. It is the same word the sandbox
   * gateway, the null SMS provider, and the in-memory search engine already
   * wear, and it means the same thing: a real, correct implementation that must
   * never be mistaken for the external thing it stands in for.
   */
  describeReadiness(): 'not_configured' | 'simulated' | 'configured' {
    if (this.byKey.size === 0) return 'not_configured';
    let provider: AiAssistantProvider;
    try {
      provider = this.resolveDefault();
    } catch {
      return 'not_configured';
    }
    return provider.respondsExternally ? 'configured' : 'simulated';
  }

  /**
   * The per-message provider state the browser is told (`AiProviderState`).
   *
   * A separate vocabulary from `describeReadiness` on purpose: that one answers
   * an operator's question about a deployment, this one answers a reader's
   * question about the sentence in front of them. Collapsing them would put
   * `not_configured` in a chat bubble.
   */
  stateOf(provider: AiAssistantProvider): AiProviderState {
    return provider.respondsExternally ? 'external' : 'simulated';
  }

  /** True when the only thing that can answer is the deterministic local assistant. */
  isDeterministicOnly(): boolean {
    return this.byKey.size === 1 && this.byKey.has(DETERMINISTIC_PROVIDER_KEY);
  }
}
