import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { deriveWorkspaceReference, workspaceReferencesMatch } from '@beauclick/workspace-reference';

import {
  FINANCE_PAGE_SIZE_DEFAULT,
  FINANCE_PAGE_SIZE_MAX,
  FinanceWorkspaceService,
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
} from './finance-workspace.service';
import { FinanceWorkspaceSelectionRequiredException } from './finance.exceptions';
import { FinancialParty } from './ports';

/**
 * The workspace-aware finance surface's pure logic — V3.3 #72, `V33-DEC-020`.
 *
 * ## What is proved here and what is deliberately not
 *
 * Ownership arithmetic, reference resolution, the singular-route outcomes and
 * cursor binding are pure: they take parties in and return a decision, so
 * proving them against a database would be slower without being stronger.
 *
 * Everything about REAL ROWS — that an affiliated professional enumerates no
 * employer workspace, that refusals are byte-identical over HTTP, that every
 * query carries its party predicate, that nothing is written — is in
 * `apps/api/test/finance-workspace-authorization.pg-spec.ts`, because none of it
 * can be observed without them.
 *
 * The secret here is a literal that exists only in this file.
 */

const SECRET = 'finance-unit-test-workspace-secret';

const OWNER = '018f4b1a-0000-7000-8000-000000000001';
const PROFESSIONAL: FinancialParty = { partyType: 'professional', partyId: '018f4b1a-0000-7000-8000-0000000000aa' };
const BUSINESS: FinancialParty = { partyType: 'business', partyId: '018f4b1a-0000-7000-8000-0000000000bb' };

function serviceFor(owned: FinancialParty[]) {
  const ledger = { entriesForOrderAndParty: jest.fn() };
  const settlements = {
    partySummary: jest.fn(),
    outstandingOrdersForParty: jest.fn(),
    settlementPageForParty: jest.fn().mockResolvedValue([]),
  };
  const owners = { ownedWorkspacesFor: jest.fn().mockResolvedValue(owned) };

  const service = new FinanceWorkspaceService(
    ledger as never,
    settlements as never,
    owners as never,
    SECRET,
  );
  return { service, ledger, settlements, owners };
}

describe('owned workspaces', () => {
  it('orders deterministically, so a client never sees the list reshuffle', async () => {
    // Handed to the service in the opposite order to the one it must return.
    const { service } = serviceFor([PROFESSIONAL, BUSINESS]);

    expect((await service.ownedWorkspaces(OWNER)).map((p) => p.partyType)).toEqual(['business', 'professional']);
  });

  it('gives a caller who owns nothing an empty list, not a fabricated party', async () => {
    const { service } = serviceFor([]);

    expect(await service.ownedWorkspaces(OWNER)).toEqual([]);
    expect(await service.workspacesFor(OWNER)).toEqual([]);
  });

  it('exposes a reference and a type, and no identity', async () => {
    const { service } = serviceFor([PROFESSIONAL, BUSINESS]);

    const entries = await service.workspacesFor(OWNER);
    const body = JSON.stringify(entries);

    expect(entries.map((e) => Object.keys(e).sort())).toEqual([
      ['workspaceRef', 'workspaceType'],
      ['workspaceRef', 'workspaceType'],
    ]);
    for (const identifier of [OWNER, PROFESSIONAL.partyId, BUSINESS.partyId]) {
      expect(body).not.toContain(identifier);
    }
  });

  it('asks the OWNERSHIP port and nothing else', async () => {
    // The whole fix in one assertion: the service has no other source of
    // parties, so it cannot fall back to a beneficiary answer.
    const { service, owners } = serviceFor([PROFESSIONAL]);

    await service.workspacesFor(OWNER);
    expect(owners.ownedWorkspacesFor).toHaveBeenCalledWith(OWNER);
    expect(owners.ownedWorkspacesFor).toHaveBeenCalledTimes(1);
  });
});

describe('resolving a reference', () => {
  it('returns the owned party a valid reference names', async () => {
    const { service } = serviceFor([PROFESSIONAL, BUSINESS]);

    await expect(service.resolveOwnedWorkspace(OWNER, service.referenceFor(OWNER, BUSINESS))).resolves.toEqual(BUSINESS);
  });

  it.each([
    ['malformed', 'not-a-reference'],
    ['wrong length', 'A'.repeat(42)],
    ['random but well-formed', 'A'.repeat(43)],
    ['empty', ''],
    ['a raw party id', PROFESSIONAL.partyId],
  ])('refuses a %s reference with the one non-enumerating exception', async (_label, supplied) => {
    const { service } = serviceFor([PROFESSIONAL, BUSINESS]);

    await expect(service.resolveOwnedWorkspace(OWNER, supplied)).rejects.toThrow(NotFoundOrNotYoursException);
  });

  it('refuses a reference minted for another owner', async () => {
    const { service } = serviceFor([PROFESSIONAL]);
    const foreign = deriveWorkspaceReference(SECRET, '018f4b1a-0000-7000-8000-000000000002', PROFESSIONAL);

    await expect(service.resolveOwnedWorkspace(OWNER, foreign)).rejects.toThrow(NotFoundOrNotYoursException);
  });

  it('refuses a party the caller no longer owns', async () => {
    // The reference is correctly signed and was valid a moment ago. Ownership is
    // re-read on every request, so it stops resolving without anything expiring.
    const { service } = serviceFor([PROFESSIONAL, BUSINESS]);
    const businessRef = service.referenceFor(OWNER, BUSINESS);

    const { service: afterSale } = serviceFor([PROFESSIONAL]);
    await expect(afterSale.resolveOwnedWorkspace(OWNER, businessRef)).rejects.toThrow(NotFoundOrNotYoursException);
  });

  it('decides through the constant-time seam, once per owned party', async () => {
    /*
     * Two assertions, and the second is what makes this more than a call count:
     * the comparison runs once per OWNED party — so resolution enumerates and
     * compares rather than looking anything up — and forcing the seam to false
     * makes a valid reference refuse. Any other path to a party would still
     * return one.
     */
    const { service } = serviceFor([PROFESSIONAL, BUSINESS]);
    const spy = jest.spyOn(FinanceWorkspaceService.prototype, 'matchesReference');
    try {
      const valid = service.referenceFor(OWNER, PROFESSIONAL);

      await expect(service.resolveOwnedWorkspace(OWNER, valid)).resolves.toEqual(PROFESSIONAL);
      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockReturnValue(false);
      await expect(service.resolveOwnedWorkspace(OWNER, valid)).rejects.toThrow(NotFoundOrNotYoursException);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the legacy singular route resolution', () => {
  it('answers about the single owned workspace', async () => {
    // Every independent professional and every business owner. Unchanged
    // behaviour, which is what keeps the existing client working.
    const { service } = serviceFor([PROFESSIONAL]);

    await expect(service.singularWorkspace(OWNER)).resolves.toEqual(PROFESSIONAL);
  });

  it('returns null when the caller owns nothing, so the controller keeps its refusal', async () => {
    const { service } = serviceFor([]);

    await expect(service.singularWorkspace(OWNER)).resolves.toBeNull();
  });

  it('REFUSES a dual owner rather than choosing for them', async () => {
    /*
     * The #72 defect as a single case. Every silent alternative — first in
     * array, business-first, professional-first, affiliation-derived — is a
     * different flavour of showing a seller half their financial position with
     * nothing saying so.
     */
    const { service } = serviceFor([BUSINESS, PROFESSIONAL]);

    await expect(service.singularWorkspace(OWNER)).rejects.toThrow(FinanceWorkspaceSelectionRequiredException);
  });

  it('uses the ratified code and status', async () => {
    const error = new FinanceWorkspaceSelectionRequiredException();

    // Lower-case, as `V33-DEC-020` ratified it, and the one exception to this
    // repository's SCREAMING_SNAKE code convention. A code is a literal clients
    // compare against, so it is kept exactly as decided.
    expect(error.code).toBe('finance_workspace_selection_required');
    expect(error.getStatus()).toBe(409);
    // No `details`: the caller learns that they own more than one workspace and
    // nothing else — not how many, not which types, not a single figure.
    expect(error.details).toBeUndefined();
  });
});

describe('the workspace-bound cursor', () => {
  const REF_A = deriveWorkspaceReference(SECRET, OWNER, PROFESSIONAL);
  const REF_B = deriveWorkspaceReference(SECRET, OWNER, BUSINESS);
  const ROW = '018f4b1a-0000-7000-8000-0000000000cc';
  const decode = (ref: string, cursor?: string) => decodeWorkspaceCursor(ref, cursor, workspaceReferencesMatch);

  it('round-trips a row id for the workspace that issued it', () => {
    expect(decode(REF_A, encodeWorkspaceCursor(REF_A, ROW))).toBe(ROW);
  });

  it('treats an absent cursor as the first page', () => {
    expect(decode(REF_A, undefined)).toBeNull();
    expect(decode(REF_A, '')).toBeNull();
  });

  it('REJECTS a cursor issued by another workspace', () => {
    /*
     * The cross-workspace paging attack, and the reason the reference is inside
     * the cursor at all. A bare `lastId` would be portable: a dual owner, or
     * anyone holding one page of a response, could page a ledger the cursor was
     * never issued for.
     *
     * Both directions, so neither workspace is a special case.
     */
    const fromBusiness = encodeWorkspaceCursor(REF_B, ROW);
    const fromProfessional = encodeWorkspaceCursor(REF_A, ROW);

    expect(() => decode(REF_A, fromBusiness)).toThrow(NotFoundOrNotYoursException);
    expect(() => decode(REF_B, fromProfessional)).toThrow(NotFoundOrNotYoursException);

    // The positive control: without it both refusals would pass against a
    // decoder that rejected every cursor.
    expect(decode(REF_A, fromProfessional)).toBe(ROW);
    expect(decode(REF_B, fromBusiness)).toBe(ROW);
  });

  it.each([
    ['not base64url at all', '!!!!'],
    ['no separator', Buffer.from('nodot', 'utf8').toString('base64url')],
    ['an empty workspace half', Buffer.from('.abc', 'utf8').toString('base64url')],
    ['a non-uuid row id', Buffer.from(`${'A'.repeat(43)}.not-a-uuid`, 'utf8').toString('base64url')],
  ])('refuses %s with the same exception a foreign reference gets', (_label, cursor) => {
    // One refusal for every cursor failure: a distinct "malformed cursor" error
    // would tell a caller their forged reference was otherwise well-formed.
    expect(() => decode(REF_A, cursor)).toThrow(NotFoundOrNotYoursException);
  });
});

describe('page bounds', () => {
  it('defaults to a bounded page and caps what a caller may ask for', async () => {
    const { service, settlements } = serviceFor([PROFESSIONAL]);
    const ref = service.referenceFor(OWNER, PROFESSIONAL);

    await service.settlementsFor(OWNER, ref);
    // `limit + 1`: one extra row is what makes `nextCursor` honest rather than
    // "a full page might mean more".
    expect(settlements.settlementPageForParty).toHaveBeenLastCalledWith(
      PROFESSIONAL.partyType,
      PROFESSIONAL.partyId,
      null,
      FINANCE_PAGE_SIZE_DEFAULT + 1,
    );

    await service.settlementsFor(OWNER, ref, { limit: 10_000 });
    expect(settlements.settlementPageForParty).toHaveBeenLastCalledWith(
      PROFESSIONAL.partyType,
      PROFESSIONAL.partyId,
      null,
      FINANCE_PAGE_SIZE_MAX + 1,
    );
  });

  it('always passes the party predicate down, whatever the page', async () => {
    // The service has no call path that reaches a settlement row without naming
    // a party, which is what stops a page from crossing workspaces.
    const { service, settlements } = serviceFor([PROFESSIONAL, BUSINESS]);

    await service.settlementsFor(OWNER, service.referenceFor(OWNER, BUSINESS));
    expect(settlements.settlementPageForParty).toHaveBeenLastCalledWith(
      'business',
      BUSINESS.partyId,
      null,
      expect.any(Number),
    );
  });
});
