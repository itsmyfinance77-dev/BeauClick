import { Injectable } from '@nestjs/common';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * `commercial`'s subject-data contract — ADR-027, ADR-041 §10, Issue #40.
 *
 * ## All five tables are `retained`, and NONE is `no_subject_data`
 *
 * Every table here carries administrator identity: `created_by_user_id`
 * throughout, and on versions also `published_by_user_id` and
 * `retired_by_user_id`. Issue #40 names the second of those specifically and
 * binds the consequence — the disposition is `retained` with a stated reason,
 * never `no_subject_data`, and the columns are not renamed to evade the
 * coverage check that recognises the `_user_id` suffix.
 *
 * The reason is the same one `admin.admin_audit_log` carries, and it is a real
 * reason rather than a formula. These rows are the immutable record of WHICH
 * ADMINISTRATOR published the commercial terms sellers were billed against. An
 * erasure able to blank that attribution would hand an operator a way to
 * launder their own commercial history: publish the terms, request deletion,
 * and the record of who set the price goes with them. The catalogue's whole
 * value is that a published version can never change; an attribution that could
 * be removed would make it change in the one way that matters most.
 *
 * `commercial.price_tiers` is claimed on the same footing rather than as
 * "reference data with no person in it". It carries `created_by_user_id`
 * because an administrator authored the tier — sometimes a different one from
 * whoever created the version around it — and claiming a table empty because it
 * *could* have been designed without an actor column is precisely the shape
 * ADR-027's `wrongly_declared_empty` check exists to catch.
 *
 * ## Nothing is exported, and that is not an oversight
 *
 * A plan version is a platform commercial record, not personal data ABOUT the
 * administrator who published it. Two consequences follow, and the second is
 * the stronger:
 *
 *   1. An administrator's subject export would gain nothing they cannot already
 *      read through the administrative surface they hold the capability for.
 *   2. Returning the catalogue through a subject export would disclose the
 *      platform's entire commercial configuration — every price, every
 *      allowance, every activation window — to anyone who requests their own
 *      data. An export route is not an authorization boundary.
 *
 * The same call `admin`'s contract makes, for the same reason.
 *
 * ## The counts are truthful
 *
 * Zero anonymized, zero deleted, and all five tables named as retained with
 * their reasons. That is a real answer rather than a stub: erasure genuinely
 * does nothing here, the report says so, and the boot-time coverage assertion
 * against the live `pg_tables` catalogue is what proves the claim was reached
 * rather than merely written.
 *
 * ## The seeded `D-7` rows carry a LABEL, not a user id
 *
 * There is no administrator at migration time, so `created_by_label` /
 * `published_by_label` hold `migration:v3.3-a` and the `_user_id` columns are
 * NULL — the same pairing `admin.admin_audit_log.actor_label` uses for the
 * documented bootstrap, and a database CHECK enforces that exactly one of each
 * pair is present. A row with no subject in it does not weaken the `retained`
 * claim: the claim is about what the TABLE may hold, and every other row in it
 * will name a real administrator.
 */
@Injectable()
export class CommercialSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'commercial';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'commercial.plans',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id. The immutable record of which administrator opened a plan key; erasing the attribution would let an operator launder their own commercial history.',
    },
    {
      table: 'commercial.plan_versions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id, published_by_user_id and retired_by_user_id. These rows are the permanent record of who published the terms sellers were billed against, and a published version can never be edited -- an attribution that could be erased would make it changeable in the one way that matters.',
    },
    {
      table: 'commercial.price_schedules',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id. Same attributability reason as commercial.plans: who opened a pricing key is part of the immutable commercial record.',
    },
    {
      table: 'commercial.price_schedule_versions',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id, published_by_user_id and retired_by_user_id. The permanent record of who published a price; erasure must not be able to detach a price from the administrator who set it.',
    },
    {
      table: 'commercial.price_tiers',
      disposition: 'retained',
      reason:
        'Carries created_by_user_id -- an administrator authored the tier, sometimes a different one from whoever created the version around it. Claimed retained rather than no_subject_data for that reason, not to satisfy the coverage check.',
    },
  ];

  /**
   * Nothing. See the class docblock: a plan version is a platform commercial
   * record rather than personal data about its publisher, and an export
   * document is not the right place to disclose the whole price list.
   */
  async exportSubjectData(): Promise<SubjectExportSection[]> {
    return [];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: this.tables.map((claim) => ({
        table: claim.table,
        reason: 'immutable commercial record; administrator attribution must survive erasure',
      })),
    };
  }
}
