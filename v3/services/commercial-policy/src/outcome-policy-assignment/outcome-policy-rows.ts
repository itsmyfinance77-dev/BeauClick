import { EntityManager } from 'typeorm';

import {
  AllowedOutcomeMembersV1,
  BookingOutcomeRetentionRule,
  BookingOutcomeSelectionV1,
  bookingOutcomeRetentionColumns,
  bookingOutcomeRetentionRuleFromColumns,
} from '@beauclick/commercial-policy-contract';

/**
 * Row mapping shared by the seller writer and the read-only resolver — V3.3
 * Story #159 (`#42b`).
 *
 * Both read the same three `#42a` tables through narrow SQL projections rather
 * than through `#42a`'s entities or services, for the line #104 and #115 drew:
 * neither the seller route nor the order path may sit one autocomplete away
 * from the administrator's `publishVersion`. Keeping the one mapping here means
 * the two readers cannot disagree about what a row means.
 */

export interface ActiveOutcomeVersionRow {
  id: string;
  version: number;
  cutoff_hours_allowed: unknown;
  no_show_grace_minutes_allowed: unknown;
  reschedule_free_count_before_cutoff: number;
  dispute_window_hours: number;
  bodily_harm_window_hours: number | null;
  appeal_window_hours: number;
  case_file_retention_days: number | null;
  legal_cap_kind: string | null;
  legal_cap_basis_points: number | null;
  legal_cap_amount_toman: string | number | null;
  legal_evidence_id: string | null;
  contract_version: number;
  resolved_at: Date;
}

export interface CurrentOutcomeAssignmentRow {
  id: string;
  policy_key: string;
  cutoff_hours: number;
  late_retention_kind: string;
  late_retention_basis_points: number | null;
  late_retention_amount_toman: string | number | null;
  grace_minutes: number;
  no_show_retention_kind: string;
  no_show_retention_basis_points: number | null;
  no_show_retention_amount_toman: string | number | null;
  assigned_at: Date;
}

/** The version of one key that is published and active at the statement's own `now()`. */
const ACTIVE_VERSION_SQL = `
  SELECT v.id, v.version, v.cutoff_hours_allowed, v.no_show_grace_minutes_allowed,
         v.reschedule_free_count_before_cutoff, v.dispute_window_hours, v.bodily_harm_window_hours,
         v.appeal_window_hours, v.case_file_retention_days,
         v.legal_cap_kind, v.legal_cap_basis_points, v.legal_cap_amount_toman, v.legal_evidence_id,
         v.contract_version, now() AS resolved_at
    FROM commercial.booking_outcome_policy_versions v
   WHERE v.policy_key = $1
     AND v.lifecycle_state = 'published'
     AND v.activation_starts_at <= now()
     AND (v.activation_ends_at IS NULL OR now() < v.activation_ends_at)`;

/**
 * Every version of `policyKey` active right now — normally zero or one;
 * `ex_bopv_no_effective_overlap` makes more unreachable, and the callers refuse
 * rather than pick if it ever happens.
 *
 * @param lock `FOR SHARE`: a retirement is an `UPDATE` of that row, so it waits
 *   until the caller's transaction ends (ADR-048 R5).
 */
export async function activeOutcomeVersions(
  manager: EntityManager,
  policyKey: string,
  lock: boolean,
): Promise<ActiveOutcomeVersionRow[]> {
  return manager.query(`${ACTIVE_VERSION_SQL}${lock ? '\n   FOR SHARE' : ''}`, [policyKey]);
}

/** The selectable retention rules of each version, in presentation order. One statement for any number of versions. */
export async function retentionOptionsFor(
  manager: EntityManager,
  versionIds: readonly string[],
): Promise<Map<string, { late: BookingOutcomeRetentionRule[]; noShow: BookingOutcomeRetentionRule[] }>> {
  const byVersion = new Map<string, { late: BookingOutcomeRetentionRule[]; noShow: BookingOutcomeRetentionRule[] }>();
  if (versionIds.length === 0) return byVersion;

  const rows: Array<{
    version_id: string;
    purpose: string;
    kind: string;
    basis_points: number | null;
    amount_toman: string | number | null;
  }> = await manager.query(
    `SELECT version_id, purpose, kind, basis_points, amount_toman
       FROM commercial.booking_outcome_policy_retention_options
      WHERE version_id = ANY($1::uuid[])
      ORDER BY version_id, purpose, ordinal`,
    [versionIds],
  );

  for (const row of rows) {
    const entry = byVersion.get(row.version_id) ?? { late: [], noShow: [] };
    const rule = retentionRuleFromColumns(row.kind, row.basis_points, row.amount_toman);
    if (row.purpose === 'late_cancellation') entry.late.push(rule);
    else if (row.purpose === 'no_show') entry.noShow.push(rule);
    byVersion.set(row.version_id, entry);
  }
  return byVersion;
}

export function allowedMembersOf(
  version: Pick<ActiveOutcomeVersionRow, 'cutoff_hours_allowed' | 'no_show_grace_minutes_allowed'>,
  options: { late: BookingOutcomeRetentionRule[]; noShow: BookingOutcomeRetentionRule[] } | undefined,
): AllowedOutcomeMembersV1 {
  return {
    cutoffHours: smallintArray(version.cutoff_hours_allowed),
    lateCancellationRetention: options?.late ?? [],
    noShowGraceMinutes: smallintArray(version.no_show_grace_minutes_allowed),
    noShowRetention: options?.noShow ?? [],
  };
}

export function selectionOfRow(row: CurrentOutcomeAssignmentRow): BookingOutcomeSelectionV1 {
  return {
    cutoffHours: Number(row.cutoff_hours),
    lateCancellationRetention: retentionRuleFromColumns(
      row.late_retention_kind,
      row.late_retention_basis_points,
      row.late_retention_amount_toman,
    ),
    noShowGraceMinutes: Number(row.grace_minutes),
    noShowRetention: retentionRuleFromColumns(
      row.no_show_retention_kind,
      row.no_show_retention_basis_points,
      row.no_show_retention_amount_toman,
    ),
  };
}

/** The contract's one column mapping, under the names this module's readers use. */
export const retentionRuleFromColumns = bookingOutcomeRetentionRuleFromColumns;
export const retentionColumnsOf = bookingOutcomeRetentionColumns;

/** `pg` parses `int2[]` to an array; a `{1,2}` literal is accepted too, as `#42a`'s entity transformer does. */
export function smallintArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\{|\}$/g, '')
    .split(',')
    .filter((item) => item.length > 0)
    .map(Number);
}
