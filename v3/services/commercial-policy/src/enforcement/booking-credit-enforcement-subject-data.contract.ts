import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

import { BookingCreditPartyGovernanceEntity } from './booking-credit-enforcement.entities';

/**
 * The control plane's two tables under ADR-027 -- V3.3 Story #95 (`#58b-1`),
 * ADR-050 §8, `V33-DEC-036` R12.
 *
 * ## A THIRD contract in this service, and why not the subscription one
 *
 * `SubscriptionSubjectDataContract` holds one invariant its own suite pins:
 * every table it claims is `retained`, because every one of them is a record
 * of what the platform OWED a seller. The control singleton is not that -- it
 * is the platform's own state, names no person, and is honestly
 * `no_subject_data` -- and putting a `no_subject_data` claim on that contract
 * would blur an invariant worth keeping sharp. So the two control tables get
 * their own contract, the same way the collection-policy assignment did.
 *
 * ## The two dispositions, and why they differ
 *
 * `booking_credit_enforcement_control`: rollout state, activation generation,
 * kill-switch state and two OPAQUE audit-row ids. No `_by` or `_user_id`
 * column anywhere -- who moved it lives in `admin.admin_audit_log`. That also
 * means ADR-027's `wrongly_declared_empty` detector could NOT catch a dishonest
 * claim here, so the disposition is pinned by an explicit test, exactly as
 * `booking_credit_grants`' is.
 *
 * `booking_credit_party_governance`: names a seller party AND the administrator
 * who recorded its state (`recorded_by_user_id`). `retained` -- an operational
 * and legal obligation record. Deleting a row would silently return a seller
 * to legacy exemption, the one thing R3 and R12 forbid; and the party id it
 * holds points at a row `provider` or `business` has already anonymized in
 * place by the time erasure reaches here. The `_user_id` suffix makes a
 * dishonest `no_subject_data` claim on it boot-refusable.
 *
 * ## What export returns
 *
 * For each party the subject OWNS: the governance state, its closed cause, and
 * when -- the facts about THEIR seller workspace. Never `recorded_by_*` (an
 * administrator's identity), never the audit id, never the proof grant id (a
 * ledger internal the grants export describes in its own terms). Ownership is
 * resolved with the same SQL the subscription contract uses -- a contract may
 * not inject a port from its module's composition root, because privacy
 * orchestrates every module inside one transaction -- so a staff member, who
 * owns neither party, receives nothing, and a customer never reaches the query.
 */
@Injectable()
export class BookingCreditEnforcementSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial-enforcement';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.booking_credit_enforcement_control',
      disposition: 'no_subject_data',
      reason:
        'The one-row platform control for booking-credit enforcement: rollout state, activation generation and kill-switch state, plus two opaque audit-row ids. No person is named; administrator identity for its mutations stays in admin.admin_audit_log (ADR-050 §8).',
    },
    {
      table: 'commercial.booking_credit_party_governance',
      disposition: 'retained',
      reason:
        'One explicit governance fact per seller party (governed or legacy_exempt) with the administrator who recorded it. An operational and legal obligation record: deleting it would silently return a seller to legacy exemption, and the party id it holds points at a row provider or business has already anonymized in place (ADR-050 §8).',
    },
  ];

  async exportSubjectData(manager: EntityManager, userId: string): Promise<SubjectExportSection[]> {
    const parties: Array<{ party_type: 'professional' | 'business'; party_id: string }> = await manager.query(
      `SELECT 'professional'::text AS party_type, p.id AS party_id
         FROM provider.professionals p WHERE p.owner_id = $1
        UNION ALL
       SELECT 'business'::text, b.id
         FROM business.businesses b WHERE b.owner_id = $1`,
      [userId],
    );
    if (parties.length === 0) return [];

    const governance = await manager
      .getRepository(BookingCreditPartyGovernanceEntity)
      .createQueryBuilder('v')
      .where(
        parties.map((_party, index) => `(v.party_type = :type${index} AND v.party_id = :id${index})`).join(' OR '),
        Object.fromEntries(parties.flatMap((party, index) => [[`type${index}`, party.party_type], [`id${index}`, party.party_id]])),
      )
      .orderBy('v.recorded_at', 'DESC')
      .getMany();

    if (governance.length === 0) return [];
    return [
      {
        key: 'commercial.booking_credit_party_governance',
        description: 'وضعیت کسب‌وکار شما در نظام اعمال اعتبار نوبت‌دهی',
        rows: governance.map((g) => ({
          subscriberPartyType: g.partyType,
          state: g.state,
          cause: g.cause,
          recordedAt: g.recordedAt.toISOString(),
          governedAt: g.governedAt ? g.governedAt.toISOString() : null,
        })),
      },
    ];
  }

  /**
   * Nothing is anonymized and nothing is deleted, and the counts say so. The
   * control singleton names nobody; the governance fact is retained so that
   * erasure can never silently return a seller to legacy exemption.
   */
  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason:
          claim.disposition === 'no_subject_data'
            ? 'platform control state naming no person'
            : 'monotonic governance fact; erasing it would silently return a seller to legacy exemption',
      })),
    };
  }
}
