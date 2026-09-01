import { Inject, Injectable } from '@nestjs/common';

import {
  BookingCommercialPolicySnapshotV1,
  BookingCommercialTermsV1,
  validateBookingCommercialTermsV1,
} from '@beauclick/commercial-policy-contract';

/**
 * Production is deliberately not a member while #46/#47 are open.
 * A deterministic sandbox policy cannot be relabelled production by an env var.
 */
export const COMMERCIAL_POLICY_RUNTIME_MODES = ['contract_only', 'sandbox'] as const;
export type CommercialPolicyRuntimeMode = (typeof COMMERCIAL_POLICY_RUNTIME_MODES)[number];

export interface CommercialPolicyDefinitionV1 {
  readonly key: string;
  readonly version: number;
  readonly runtimeMode: CommercialPolicyRuntimeMode;
  readonly terms: BookingCommercialTermsV1;
}

export const COMMERCIAL_POLICY_DEFINITIONS = Symbol('COMMERCIAL_POLICY_DEFINITIONS');

export class InvalidCommercialPolicyDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCommercialPolicyDefinitionError';
  }
}

export class CommercialPolicyNotRegisteredError extends Error {
  constructor(key: string, version: number) {
    super(`Commercial policy ${key}@${version} is not registered.`);
    this.name = 'CommercialPolicyNotRegisteredError';
  }
}

function identityOf(definition: Pick<CommercialPolicyDefinitionV1, 'key' | 'version'>): string {
  return `${definition.key}@${definition.version}`;
}

function frozenDefinition(definition: CommercialPolicyDefinitionV1): CommercialPolicyDefinitionV1 {
  const deposit = Object.freeze({ ...definition.terms.deposit });
  const terms = Object.freeze({ ...definition.terms, deposit });
  return Object.freeze({ ...definition, terms });
}

/**
 * An explicit registry with no default and no fallback.
 *
 * Callers request an exact key AND version. Asking for "latest" would make a
 * historical booking silently adopt live configuration, which ADR-039 forbids.
 */
@Injectable()
export class CommercialPolicyRegistry {
  private readonly definitions: ReadonlyMap<string, CommercialPolicyDefinitionV1>;

  constructor(
    @Inject(COMMERCIAL_POLICY_DEFINITIONS)
    definitions: readonly CommercialPolicyDefinitionV1[],
  ) {
    const registered = new Map<string, CommercialPolicyDefinitionV1>();
    for (const definition of definitions) {
      const snapshotProblems = validateBookingCommercialTermsV1(definition.terms);
      if (snapshotProblems.length > 0) {
        throw new InvalidCommercialPolicyDefinitionError(
          `${identityOf(definition)} is invalid: ${snapshotProblems.join('; ')}`,
        );
      }
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.key)) {
        throw new InvalidCommercialPolicyDefinitionError(`${identityOf(definition)} has an invalid stable key.`);
      }
      if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
        throw new InvalidCommercialPolicyDefinitionError(`${identityOf(definition)} has an invalid version.`);
      }
      if (!(COMMERCIAL_POLICY_RUNTIME_MODES as readonly string[]).includes(definition.runtimeMode)) {
        throw new InvalidCommercialPolicyDefinitionError(`${identityOf(definition)} has an unsupported runtime mode.`);
      }
      const identity = identityOf(definition);
      if (registered.has(identity)) {
        throw new InvalidCommercialPolicyDefinitionError(`${identity} is registered more than once.`);
      }
      registered.set(identity, frozenDefinition(definition));
    }
    this.definitions = registered;
  }

  resolve(key: string, version: number): CommercialPolicyDefinitionV1 {
    const definition = this.definitions.get(identityOf({ key, version }));
    if (!definition) throw new CommercialPolicyNotRegisteredError(key, version);
    return definition;
  }

  snapshot(key: string, version: number, acceptedAt: Date): BookingCommercialPolicySnapshotV1 {
    if (Number.isNaN(acceptedAt.getTime())) throw new InvalidCommercialPolicyDefinitionError('acceptedAt is invalid.');
    const definition = this.resolve(key, version);
    return Object.freeze({
      policyKey: definition.key,
      policyVersion: definition.version,
      acceptedAt: acceptedAt.toISOString(),
      terms: definition.terms,
    });
  }

  /** Readiness may report counts and modes, never numeric customer terms. */
  readiness(): Readonly<{ registered: number; sandbox: number; productionAvailable: false }> {
    let sandbox = 0;
    for (const definition of this.definitions.values()) if (definition.runtimeMode === 'sandbox') sandbox += 1;
    return Object.freeze({ registered: this.definitions.size, sandbox, productionAvailable: false });
  }
}
