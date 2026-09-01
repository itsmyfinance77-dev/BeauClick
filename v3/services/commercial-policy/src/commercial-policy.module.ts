import { DynamicModule, Module } from '@nestjs/common';

import {
  COMMERCIAL_POLICY_DEFINITIONS,
  CommercialPolicyDefinitionV1,
  CommercialPolicyRegistry,
} from './commercial-policy.registry';
import { CommercialPolicyControlGate } from './commercial-policy-control.gate';

/**
 * Not composed into the API by Story #39: the foundation has no money-moving
 * port and no route. Later composition must register exact immutable versions.
 */
@Module({})
export class CommercialPolicyModule {
  static register(definitions: readonly CommercialPolicyDefinitionV1[] = []): DynamicModule {
    return {
      module: CommercialPolicyModule,
      providers: [
        { provide: COMMERCIAL_POLICY_DEFINITIONS, useValue: definitions },
        CommercialPolicyRegistry,
        CommercialPolicyControlGate,
      ],
      exports: [CommercialPolicyRegistry, CommercialPolicyControlGate],
    };
  }
}
