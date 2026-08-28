import { Injectable } from '@nestjs/common';

import {
  SubjectDataContract,
  SubjectErasureOutcome,
  SubjectExportSection,
  SubjectTableClaim,
} from '@beauclick/subject-data';

/**
 * search's subject-data contract -- the module whose erasure work is done
 * ENTIRELY BY SOMEBODY ELSE, and the one place where saying so plainly matters
 * more than doing something.
 *
 * `search.provider_documents` holds a copy of a professional's display name
 * and bio. That is unambiguously personal data, and an erasure that left it
 * behind would leave the erased name being served by `/v1/search` -- the one
 * surface the public actually looks at.
 *
 * It is not erased here, and that is deliberate rather than an omission. The
 * document is a PROJECTION. Provider's contract sets `deleted_at` and emits
 * `ProfessionalUpdated` carrying `isDeleted: true` in the same transaction;
 * the existing projection handler then marks the document deleted and the
 * flush removes it from OpenSearch. Writing a second, independent deletion
 * here would create two mechanisms for one outcome, free to disagree -- and
 * the one that ran outside the projection's revision ordering would be the one
 * that loses a race with an in-flight reindex and quietly resurrects the
 * document.
 *
 * One mechanism, tested end to end (`privacy.pg-spec.ts` asserts the erased
 * name is gone from the projection), beats two that both look right.
 *
 * NOTHING FROM THIS SCHEMA IS EXPORTED either. Every row is derived from data
 * provider already exports, and shipping a projection alongside its source
 * would give the subject the same facts twice in two shapes -- one of which
 * would be stale whenever the index was behind.
 */
@Injectable()
export class SearchSubjectDataContract implements SubjectDataContract {
  readonly moduleKey = 'search';

  readonly tables: ReadonlyArray<SubjectTableClaim> = [
    {
      table: 'search.provider_documents',
      disposition: 'subject_data',
      // Claimed as subject_data rather than retained precisely because it DOES
      // hold a name and a bio. The disposition states what is in the table;
      // where the erasure happens is a separate question, answered above.
    },
    {
      table: 'search.ranking_signals',
      disposition: 'no_subject_data',
      reason: 'Counters keyed by professional id. No name, no contact detail, no free text.',
    },
    {
      table: 'search.signal_applications',
      disposition: 'no_subject_data',
      reason: 'Idempotency ledger of (event id, signal). Records which events were applied, never who.',
    },
    {
      table: 'search.index_state',
      disposition: 'no_subject_data',
      reason: 'Which physical index is live and at what mapping version.',
    },
    { table: 'search.outbox_events', disposition: 'retained', reason: 'Transactional outbox.' },
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
          table: 'search.provider_documents',
          reason:
            'erased through provider\'s ProfessionalUpdated(isDeleted) projection rather than here, so one mechanism owns document removal',
        },
      ],
    };
  }
}
