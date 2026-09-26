import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  OWNED_SUBSCRIBER_PARTY_RESOLVER,
  OwnedSubscriberParty,
  OwnedSubscriberPartyResolver,
} from '@beauclick/commercial-policy';
import {
  FINANCE_WORKSPACE_LABEL_RESOLVER,
  FinanceWorkspaceLabelResolver,
  financePartyKey,
} from '@beauclick/financial';
import { WORKSPACE_REFERENCE_SECRET, WorkspaceParty, deriveWorkspaceReference } from '@beauclick/workspace-reference';

/**
 * One seller workspace the session OWNS — V3.3 #210.
 *
 * Three fields and no fourth. `workspaceRef` is the opaque, session-bound
 * reference every seller workspace route already accepts; `workspaceType` is
 * the two-valued classification a seller already knows about their own
 * business; `displayLabel` is the public name. No party id, no count, no
 * financial figure, no access mode — there is only one mode here, `owner` —
 * and no capability list (#210 leaves that question open, and the server
 * refuses correctly without it).
 */
export interface SellerWorkspaceEntry {
  workspaceRef: string;
  workspaceType: 'professional' | 'business';
  displayLabel: string;
}

/**
 * `GET /v1/me/workspaces` — the ownership-scoped workspace list for seller
 * surfaces, V3.3 #210.
 *
 * ## Why this exists when `/me/finance/workspaces` already lists workspaces
 *
 * That list answers a FINANCE question: which workspaces may this session
 * read money in, `owned ∪ live finance_read grant` (#111, `V33-DEC-020`). The
 * seller commercial surfaces — outcome and collection policy, subscriptions,
 * credit purchases — ask a different one: which workspaces does this session
 * OWN. Screen 48 answered it by filtering the finance list to `owner`, which is
 * correct today and points the wrong way: a policy screen depended on a
 * finance route's access rules, and the two are governed by different
 * decisions that are free to diverge.
 *
 * ## One ownership predicate, the one the routes themselves use
 *
 * The parties come from `OWNED_SUBSCRIBER_PARTY_RESOLVER` — the resolver every
 * commercial-policy seller route resolves a `workspaceRef` against. So the set
 * this lists and the set those routes accept are one set by construction, not
 * two predicates kept in step: `owner_id` only, soft-deleted rows excluded,
 * `business_staff` never consulted. An affiliated `staff` or `manager`, and a
 * `finance_read` grantee, own nothing and get nothing here.
 *
 * ## Why in `apps/api`
 *
 * Ownership spans the professional profile and the business, and ADR-011
 * forbids a service importing another — the placement `BookingRemedyController`
 * and `CheckoutController` have for the same reason. The reference primitive
 * and the public-name source are the shared ones, so every reference minted
 * here is byte-identical to the one the subscription and finance surfaces mint
 * for the same owner and party.
 *
 * ## The label source
 *
 * `FINANCE_WORKSPACE_LABEL_RESOLVER` is the composition root's public-name
 * adapter (`display_name` of live `provider.professionals` /
 * `business.businesses` rows). It holds no access rule — it names only the
 * parties it is handed — which is why reusing it does not re-create the
 * dependency this route removes; the checkout disclosure reuses it the same
 * way. It is asked only after the owned set is known and only for that set. A
 * party whose row is gone by then is omitted: it is no longer owned in any
 * sense the seller routes would honour.
 *
 * ## Ordering, and nothing selected
 *
 * `(partyType, partyId)`, the finance list's order, so a client gets a stable
 * list. Ordering never selects: no workspace is pre-chosen for the caller
 * (`V33-DEC-020`), and this service has no notion of a "current" one.
 *
 * ## Nothing here logs
 *
 * A `workspaceRef` is a stable per-seller identifier within a session; like
 * `FinanceWorkspaceService`, this class writes no log line.
 */
@Injectable()
export class MyWorkspacesService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(OWNED_SUBSCRIBER_PARTY_RESOLVER) private readonly owned: OwnedSubscriberPartyResolver,
    @Inject(FINANCE_WORKSPACE_LABEL_RESOLVER) private readonly publicNames: FinanceWorkspaceLabelResolver,
    @Inject(WORKSPACE_REFERENCE_SECRET) private readonly secret: string,
  ) {}

  async workspacesFor(sessionUserId: string): Promise<SellerWorkspaceEntry[]> {
    if (!sessionUserId) return [];

    const parties = [...(await this.owned.ownedPartiesFor(this.dataSource.manager, sessionUserId))].sort(
      (left, right) => left.partyType.localeCompare(right.partyType) || left.partyId.localeCompare(right.partyId),
    );
    // A customer who owns nothing costs two ownership reads and no name read.
    if (parties.length === 0) return [];

    const labels = await this.publicNames.labelsFor(parties);
    const entries: SellerWorkspaceEntry[] = [];
    for (const party of parties) {
      const displayLabel = labels.get(financePartyKey(party));
      if (displayLabel === undefined) continue;
      entries.push({
        workspaceRef: this.referenceFor(sessionUserId, party),
        workspaceType: party.partyType,
        displayLabel,
      });
    }
    return entries;
  }

  private referenceFor(sessionUserId: string, party: OwnedSubscriberParty): string {
    return deriveWorkspaceReference(this.secret, sessionUserId, party as WorkspaceParty);
  }
}
