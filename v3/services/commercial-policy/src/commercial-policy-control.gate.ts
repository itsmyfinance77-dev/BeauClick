import { Injectable } from '@nestjs/common';

export const COMMERCIAL_POLICY_CONTROL_REFUSALS = [
  'kill_switch_active',
  'rollout_disabled',
  'entitlement_missing',
  'business_policy_disabled',
] as const;
export type CommercialPolicyControlRefusal = (typeof COMMERCIAL_POLICY_CONTROL_REFUSALS)[number];

export interface CommercialPolicyControls {
  readonly rolloutEnabled: boolean;
  readonly entitlementGranted: boolean;
  readonly businessPolicyEnabled: boolean;
  readonly killSwitchActive: boolean;
}

export type CommercialPolicyControlDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: CommercialPolicyControlRefusal }>;

/**
 * Keeps the four control planes independent and fail-closed.
 *
 * This result is internal. A public controller must collapse reasons where
 * disclosure would reveal subscription, rollout or incident state.
 */
@Injectable()
export class CommercialPolicyControlGate {
  decide(controls: CommercialPolicyControls): CommercialPolicyControlDecision {
    if (controls.killSwitchActive) return { allowed: false, reason: 'kill_switch_active' };
    if (!controls.rolloutEnabled) return { allowed: false, reason: 'rollout_disabled' };
    if (!controls.entitlementGranted) return { allowed: false, reason: 'entitlement_missing' };
    if (!controls.businessPolicyEnabled) return { allowed: false, reason: 'business_policy_disabled' };
    return { allowed: true };
  }
}
