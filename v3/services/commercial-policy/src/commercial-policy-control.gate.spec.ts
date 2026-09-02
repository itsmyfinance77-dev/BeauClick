import { CommercialPolicyControlGate } from './commercial-policy-control.gate';

describe('CommercialPolicyControlGate', () => {
  const gate = new CommercialPolicyControlGate();
  const allowed = {
    rolloutEnabled: true,
    entitlementGranted: true,
    businessPolicyEnabled: true,
    killSwitchActive: false,
  } as const;

  it('allows only when all four independent controls allow', () => {
    expect(gate.decide(allowed)).toEqual({ allowed: true });
  });

  it.each([
    ['killSwitchActive', true, 'kill_switch_active'],
    ['rolloutEnabled', false, 'rollout_disabled'],
    ['entitlementGranted', false, 'entitlement_missing'],
    ['businessPolicyEnabled', false, 'business_policy_disabled'],
  ] as const)('fails closed when %s is %s', (key, value, reason) => {
    expect(gate.decide({ ...allowed, [key]: value })).toEqual({ allowed: false, reason });
  });

  it('gives the emergency kill switch precedence over every commercial control', () => {
    expect(
      gate.decide({
        rolloutEnabled: false,
        entitlementGranted: false,
        businessPolicyEnabled: false,
        killSwitchActive: true,
      }),
    ).toEqual({ allowed: false, reason: 'kill_switch_active' });
  });
});
