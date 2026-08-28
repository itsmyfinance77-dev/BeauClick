import { Injectable } from '@nestjs/common';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * admin's subject-data contract -- retained, and not exported either.
 *
 * WHY IT SURVIVES ERASURE. `admin.admin_audit_log` exists so a privileged
 * action stays attributable. An erasure that could remove rows from it would
 * hand every operator a way to launder their own history: take an action,
 * request deletion, and the record of what they did goes with them. The table
 * is append-only under its own owner role for exactly that reason, so the
 * application role could not delete from it in any case -- the database
 * enforces this claim rather than merely agreeing with it.
 *
 * WHY IT IS NOT IN THE EXPORT. Two reasons, and the second is the stronger:
 *
 *   1. Almost every row about a subject records what an OPERATOR did TO them,
 *      and `before_state`/`after_state` routinely name the operator, quote a
 *      moderator's private reasoning, or describe a third party's report.
 *   2. The rows a subject would most want are the ones about moderation
 *      decisions -- and handing somebody the internal reasoning behind a
 *      takedown, including who triggered it, is how a moderation system gets
 *      turned into a retaliation tool.
 *
 * The two audit actions the subject genuinely needs to see are their own
 * privacy requests, and those are exported by `privacy` from
 * `privacy.data_requests`, where they belong.
 */
@Injectable()
export class AuditSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'admin';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'admin.admin_audit_log',
      disposition: 'retained',
      reason:
        'Append-only under its own owner role. It exists so privileged actions stay attributable; an erasure able to touch it would be a way to launder an operator\'s own history.',
    },
  ];

  async exportSubjectData(): Promise<SubjectExportSection[]> {
    return [];
  }

  async eraseSubjectData(): Promise<SubjectErasureOutcome> {
    return {
      moduleKey: this.moduleKey,
      anonymized: 0,
      deleted: 0,
      retained: [
        {
          table: 'admin.admin_audit_log',
          reason: 'append-only attributability record for privileged actions',
        },
      ],
    };
  }
}
