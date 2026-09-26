import type { DataSource, EntityManager } from 'typeorm';

import {
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
  WorkspaceReferenceService,
} from '@beauclick/commercial-policy';
import { FinanceWorkspaceLabelResolver, FinancialParty, financePartyKey } from '@beauclick/financial';
import { deriveWorkspaceReference, resolveWorkspaceReference } from '@beauclick/workspace-reference';

import { MyWorkspacesService } from './my-workspaces.service';

/**
 * `MyWorkspacesService` — V3.3 #210, without a database.
 *
 * The real-PostgreSQL suite (`my-workspaces.pg-spec.ts`) proves the route
 * against real ownership rows, affiliation and grants. This one pins the parts
 * that are pure: what is asked of whom, in what order, and exactly what leaves.
 */
describe('MyWorkspacesService (#210)', () => {
  const SECRET = 'unit-test-workspace-reference-secret-of-sufficient-length';
  const USER = '0192f0a0-0000-7000-8000-000000000001';
  const PROFESSIONAL: OwnedSubscriberParty = { partyType: 'professional', partyId: '0192f0a0-0000-7000-8000-00000000000a' };
  const BUSINESS: OwnedSubscriberParty = { partyType: 'business', partyId: '0192f0a0-0000-7000-8000-00000000000b' };

  const manager = { marker: 'the application manager' } as unknown as EntityManager;
  const dataSource = { manager } as unknown as DataSource;

  function build(owned: OwnedSubscriberParty[], names: Record<string, string>) {
    const resolver: jest.Mocked<OwnedSubscriberPartyResolver> = {
      ownedPartiesFor: jest.fn().mockResolvedValue(owned),
      isEligible: jest.fn(),
    };
    const labels: jest.Mocked<FinanceWorkspaceLabelResolver> = {
      labelsFor: jest.fn(async (parties: readonly FinancialParty[]) => {
        const map = new Map<string, string>();
        for (const party of parties) {
          const name = names[financePartyKey(party)];
          if (name !== undefined) map.set(financePartyKey(party), name);
        }
        return map;
      }),
    };
    return { service: new MyWorkspacesService(dataSource, resolver, labels, SECRET), resolver, labels };
  }

  const named = { [financePartyKey(PROFESSIONAL)]: 'نگار', [financePartyKey(BUSINESS)]: 'سالن نگار' };

  it('asks the ownership resolver the routes use, on the application manager, for the session user', async () => {
    const { service, resolver } = build([PROFESSIONAL], named);
    await service.workspacesFor(USER);
    expect(resolver.ownedPartiesFor).toHaveBeenCalledTimes(1);
    expect(resolver.ownedPartiesFor).toHaveBeenCalledWith(manager, USER);
    expect(resolver.isEligible).not.toHaveBeenCalled();
  });

  it('answers an empty list for a caller who owns nothing, and computes no name', async () => {
    const { service, labels } = build([], named);
    await expect(service.workspacesFor(USER)).resolves.toEqual([]);
    expect(labels.labelsFor).not.toHaveBeenCalled();
  });

  it('answers an empty list for an empty session id without asking anyone', async () => {
    const { service, resolver, labels } = build([PROFESSIONAL], named);
    await expect(service.workspacesFor('')).resolves.toEqual([]);
    expect(resolver.ownedPartiesFor).not.toHaveBeenCalled();
    expect(labels.labelsFor).not.toHaveBeenCalled();
  });

  it('projects exactly reference, type and label — no id, count, figure, access mode or capability', async () => {
    const { service } = build([PROFESSIONAL], named);
    const [entry] = await service.workspacesFor(USER);
    expect(Object.keys(entry).sort()).toEqual(['displayLabel', 'workspaceRef', 'workspaceType']);
    expect(entry).toEqual({
      workspaceRef: deriveWorkspaceReference(SECRET, USER, PROFESSIONAL),
      workspaceType: 'professional',
      displayLabel: 'نگار',
    });
    expect(JSON.stringify(entry)).not.toContain(PROFESSIONAL.partyId);
    expect(JSON.stringify(entry)).not.toContain(USER);
  });

  it('lists a dual owner both workspaces in (partyType, partyId) order, whatever order ownership answered in', async () => {
    const { service } = build([PROFESSIONAL, BUSINESS], named);
    const entries = await service.workspacesFor(USER);
    expect(entries.map((entry) => entry.workspaceType)).toEqual(['business', 'professional']);

    const reversed = build([BUSINESS, PROFESSIONAL], named);
    await expect(reversed.service.workspacesFor(USER)).resolves.toEqual(entries);
  });

  it('names only the owned parties, in one call', async () => {
    const { service, labels } = build([PROFESSIONAL, BUSINESS], named);
    await service.workspacesFor(USER);
    expect(labels.labelsFor).toHaveBeenCalledTimes(1);
    expect([...labels.labelsFor.mock.calls[0][0]]).toEqual([BUSINESS, PROFESSIONAL]);
  });

  it('omits a party whose public row is gone by the time it is named', async () => {
    const { service } = build([PROFESSIONAL, BUSINESS], { [financePartyKey(PROFESSIONAL)]: 'نگار' });
    const entries = await service.workspacesFor(USER);
    expect(entries.map((entry) => entry.workspaceType)).toEqual(['professional']);
  });

  it('mints the reference the commercial seller routes resolve, and only for this session', async () => {
    const { service } = build([PROFESSIONAL, BUSINESS], named);
    const entries = await service.workspacesFor(USER);
    const surface = new WorkspaceReferenceService(SECRET);

    for (const [index, party] of [BUSINESS, PROFESSIONAL].entries()) {
      // What `WorkspaceReferenceService.resolve` — the subscription, credit and
      // policy routes' resolver — answers for this reference and this owner.
      expect(surface.resolve(USER, [PROFESSIONAL, BUSINESS], entries[index].workspaceRef)).toEqual(party);
    }

    // Another session presenting the same value matches nothing.
    const stranger = '0192f0a0-0000-7000-8000-0000000000ff';
    for (const entry of entries) {
      expect(
        resolveWorkspaceReference(SECRET, stranger, [PROFESSIONAL, BUSINESS], entry.workspaceRef, (a, b) => a === b),
      ).toBeNull();
    }
  });
});
