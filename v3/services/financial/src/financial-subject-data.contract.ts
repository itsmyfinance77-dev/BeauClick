import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { MyFinanceService } from './my-finance.service';
import { FundJournalService } from './fund-journal.service';
import { FinanceWorkspaceOwnerResolver, FINANCE_WORKSPACE_OWNER_RESOLVER } from './ports';

/**
 * financial's subject-data contract -- the one module that is `retained` end
 * to end, and the one whose contract ignores the caller's `EntityManager`.
 *
 * WHY THE MANAGER IS IGNORED. `privacy` runs export and erasure inside one
 * transaction on the APPLICATION DataSource, and the application role holds no
 * privilege whatsoever on `financial.*` (ADR-017). A query issued through that
 * manager would not return an incomplete ledger -- it would be refused
 * outright. This module therefore reads through `MyFinanceService`, which owns
 * the second connection, and the export is one read outside the snapshot.
 *
 * That is a real, disclosed limitation rather than a detail: financial rows
 * committed between the transaction's snapshot and this read would appear in
 * the export, so the document is consistent within the application database
 * and eventually consistent with the ledger. The alternative -- a distributed
 * transaction across two connections for a read-only export -- would be a
 * substantial amount of machinery to make a report a few milliseconds more
 * self-consistent, and the export is not a financial statement.
 *
 * WHY NOTHING IS ERASED. `V3.1_PRODUCT_ROADMAP.md` §15-E is unambiguous:
 * "erasure must be anonymization-with-referential-integrity, not deletion --
 * `financial.ledger_entries` is append-only by database role and legally must
 * persist". And it is not merely policy: the application role has no UPDATE
 * and no DELETE on these tables, so an erasure that tried would fail. The
 * database enforces this contract's honesty.
 *
 * WHY IT IS EXPORTED THROUGH `MyFinanceService`. That class exists because of
 * GAP-05: every method takes a session user id and nothing else, and resolves
 * the party internally. Reading the ledger directly here would reintroduce the
 * exact caller-supplies-identity shape that class was built to remove -- in a
 * new call site, one typo away from exporting another party's earnings.
 */
@Injectable()
export class FinancialSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'financial';

  constructor(
    private readonly finance: MyFinanceService,
    private readonly fundJournal: FundJournalService,
    @Inject(FINANCE_WORKSPACE_OWNER_RESOLVER) private readonly owners: FinanceWorkspaceOwnerResolver,
  ) {}

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'financial.ledger_entries',
      disposition: 'retained',
      reason:
        'Append-only by database role and legally required to persist. The application role holds no UPDATE or DELETE on it, so erasure could not touch it even if policy allowed.',
    },
    {
      table: 'financial.settlement_batches',
      disposition: 'retained',
      reason: 'Payout records reconciled against the ledger. Same append-only role, same legal retention.',
    },
    {
      table: 'financial.settlement_items',
      disposition: 'retained',
      reason: 'Per-order lines of a retained settlement.',
    },
    {
      table: 'financial.outbox_events',
      disposition: 'retained',
      reason: 'The financial outbox, on the same isolated connection and under the same append-only role.',
    },
    {
      table: 'financial.fund_journals',
      disposition: 'retained',
      reason:
        'The pending-funds journal (ADR-052 §4, `#43a`). Append-only by database role and the append-only half of the same legal-retention reasoning as the legacy ledger -- an accounting fact is not erasable because a subject later asks.',
    },
    {
      table: 'financial.fund_postings',
      disposition: 'retained',
      reason: 'Every balanced leg of a retained journal (ADR-052 §15). Same append-only role, same retention.',
    },
  ];

  /**
   * The subject's own financial position, if they are a seller at all.
   *
   * The port's `EntityManager` parameter is accepted and deliberately unused
   * -- see the class note. Reading the ledger through it would be refused by
   * PostgreSQL, not silently wrong, which is the failure mode this design
   * prefers.
   *
   * A customer who never sold anything gets empty sections rather than missing
   * ones: an absent key is indistinguishable from a module that failed, and
   * the subject is entitled to know the answer was "nothing".
   */
  async exportSubjectData(_manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const [summary, settlements, outstanding] = await Promise.all([
      this.finance.mySummary(userId),
      this.finance.mySettlements(userId),
      this.finance.myOutstandingOrders(userId),
    ]);

    // Every OWNED party's fund states (ADR-052 §15: "to the seller: its own
    // states") -- read through `ownedWorkspacesFor` directly rather than
    // `MyFinanceService`'s singular methods, which throw
    // `FinanceWorkspaceSelectionRequiredException` for a dual owner (V33-DEC-020).
    // An export must never fail for the exact sellers #111 exists to serve.
    const ownedParties = await this.owners.ownedWorkspacesFor(userId);
    const fundStates = await Promise.all(
      ownedParties.map(async (party) => ({
        partyType: party.partyType,
        ...(await this.fundJournal.statesForParty(party.partyType, party.partyId)),
      })),
    );

    return [
      {
        key: 'earnings_summary',
        description: 'خلاصه مالی شما به عنوان فروشنده (اگر فروشنده باشید)',
        rows: summary ? [summary as unknown as Record<string, unknown>] : [],
      },
      {
        key: 'settlements',
        description: 'تسویه‌حساب‌های شما',
        rows: (settlements ?? []).map((s) => ({
          id: s.id,
          kind: s.kind,
          amountToman: s.amountToman,
          currency: s.currency,
          method: s.method,
          reference: s.reference,
          createdAt: s.createdAt,
        })),
      },
      {
        key: 'outstanding_orders',
        description: 'سفارش‌های تسویه‌نشده',
        rows: (outstanding ?? []) as unknown as Array<Record<string, unknown>>,
      },
      {
        key: 'fund_states',
        description: 'وضعیت وجوه در حال انتظار شما (#43a)',
        rows: fundStates as unknown as Array<Record<string, unknown>>,
      },
    ];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((t) => ({ table: t.table, reason: t.reason ?? 'unstated' })),
    };
  }
}
