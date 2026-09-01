import { BookingCommercialTermsV1 } from '@beauclick/commercial-policy-contract';

import {
  CommercialPolicyNotRegisteredError,
  CommercialPolicyRegistry,
  InvalidCommercialPolicyDefinitionError,
} from './commercial-policy.registry';

const terms = (): BookingCommercialTermsV1 => ({
  contractVersion: 1,
  collectionMode: 'deposit_online_balance_at_venue',
  deposit: { kind: 'fixed', amountToman: 100_000 },
  cancellationCutoffMinutesBeforeStart: 1_440,
  lateCancellationRetainBasisPointsOfDeposit: 10_000,
  noShowRetainBasisPointsOfDeposit: 10_000,
  providerCancellationRefundBasisPointsOfDeposit: 10_000,
  platformFaultRefundBasisPointsOfDeposit: 10_000,
  rescheduleDepositAction: 'transfer_deposit',
  disputeWindowMinutes: 2_880,
  settlementDelayMinutes: 2_880,
  customerPolicyCopyVersion: 'fa-IR.v1',
});

describe('CommercialPolicyRegistry', () => {
  it('requires an exact key and version and never guesses latest or a default', () => {
    const registry = new CommercialPolicyRegistry([
      { key: 'salon_deposit', version: 1, runtimeMode: 'contract_only', terms: terms() },
      { key: 'salon_deposit', version: 2, runtimeMode: 'sandbox', terms: { ...terms(), customerPolicyCopyVersion: 'fa-IR.v2' } },
    ]);

    expect(registry.resolve('salon_deposit', 1).terms.customerPolicyCopyVersion).toBe('fa-IR.v1');
    expect(registry.resolve('salon_deposit', 2).terms.customerPolicyCopyVersion).toBe('fa-IR.v2');
    expect(() => registry.resolve('salon_deposit', 3)).toThrow(CommercialPolicyNotRegisteredError);
    expect(() => registry.resolve('missing', 1)).toThrow(CommercialPolicyNotRegisteredError);
  });

  it('refuses duplicate identities instead of making registration order a policy', () => {
    const definition = { key: 'salon_deposit', version: 1, runtimeMode: 'sandbox' as const, terms: terms() };
    expect(() => new CommercialPolicyRegistry([definition, definition])).toThrow(/registered more than once/);
  });

  it('refuses invalid definitions at boot, including a fabricated production mode', () => {
    expect(
      () =>
        new CommercialPolicyRegistry([
          {
            key: 'salon_deposit',
            version: 1,
            runtimeMode: 'production' as 'sandbox',
            terms: terms(),
          },
        ]),
    ).toThrow(/unsupported runtime mode/);

    expect(
      () =>
        new CommercialPolicyRegistry([
          {
            key: '../bad',
            version: 0,
            runtimeMode: 'sandbox',
            terms: { ...terms(), providerCancellationRefundBasisPointsOfDeposit: 0 } as unknown as BookingCommercialTermsV1,
          },
        ]),
    ).toThrow(InvalidCommercialPolicyDefinitionError);
  });

  it('freezes the registered definition and the booking snapshot', () => {
    const mutable = { key: 'salon_deposit', version: 1, runtimeMode: 'sandbox' as const, terms: terms() };
    const registry = new CommercialPolicyRegistry([mutable]);
    const resolved = registry.resolve('salon_deposit', 1);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.terms)).toBe(true);
    expect(Object.isFrozen(resolved.terms.deposit)).toBe(true);

    mutable.terms = { ...terms(), customerPolicyCopyVersion: 'changed-after-registration' };
    expect(registry.resolve('salon_deposit', 1).terms.customerPolicyCopyVersion).toBe('fa-IR.v1');

    const snapshot = registry.snapshot('salon_deposit', 1, new Date('2026-09-01T12:00:00.000Z'));
    expect(snapshot).toEqual({
      policyKey: 'salon_deposit',
      policyVersion: 1,
      acceptedAt: '2026-09-01T12:00:00.000Z',
      terms: resolved.terms,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('reports honest readiness without exposing numeric policy terms', () => {
    const registry = new CommercialPolicyRegistry([
      { key: 'copy_only', version: 1, runtimeMode: 'contract_only', terms: terms() },
      { key: 'sandbox_deposit', version: 1, runtimeMode: 'sandbox', terms: terms() },
    ]);
    expect(registry.readiness()).toEqual({ registered: 2, sandbox: 1, productionAvailable: false });
    expect(JSON.stringify(registry.readiness())).not.toMatch(/100000|1440|deposit/i);
  });

  it('refuses an invalid accepted instant', () => {
    const registry = new CommercialPolicyRegistry([
      { key: 'salon_deposit', version: 1, runtimeMode: 'sandbox', terms: terms() },
    ]);
    expect(() => registry.snapshot('salon_deposit', 1, new Date('invalid'))).toThrow(/acceptedAt/);
  });
});
