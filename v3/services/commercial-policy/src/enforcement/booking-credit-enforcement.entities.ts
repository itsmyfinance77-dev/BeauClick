import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { SubscriberPartyType } from '@beauclick/commercial-policy-contract';

/**
 * The two control-plane tables of ADR-050 §2 — V3.3 Story #95 (`#58b-1`).
 *
 * ## Read these as projections of a schema whose rules live in SQL
 *
 * Nothing here enforces anything, exactly as the subscription and ledger
 * entities say of themselves. The singleton identity, every valid-state CHECK,
 * the one-way rollout, the monotonic governance transition and the refusal of
 * DELETE are all in
 * `database/migrations/commercial/20260917100001_create_booking_credit_enforcement_controls.sql`,
 * because a guarantee upheld by an entity is upheld by whoever remembers to go
 * through the entity.
 *
 * ## No commercial value
 *
 * Neither entity carries an allowance, price, quantity bound or policy
 * parameter, and the guard in `no-hardcoded-allowance.spec.ts` scans this file
 * like every other.
 */

export const ENFORCEMENT_ROLLOUT_STATES = ['inactive', 'active'] as const;
export type EnforcementRolloutState = (typeof ENFORCEMENT_ROLLOUT_STATES)[number];

export const KILL_SWITCH_STATES = ['released', 'engaged'] as const;
export type KillSwitchState = (typeof KILL_SWITCH_STATES)[number];

export const PARTY_GOVERNANCE_STATES = ['legacy_exempt', 'governed'] as const;
export type PartyGovernanceState = (typeof PARTY_GOVERNANCE_STATES)[number];

/**
 * The closed cause vocabulary. `created_under_enforcement` is reserved for
 * #141 (`#58b-2`); no #95 code path writes it, and a fast test pins that.
 */
export const PARTY_GOVERNANCE_CAUSES = ['explicit_transition', 'explicit_exemption', 'created_under_enforcement'] as const;
export type PartyGovernanceCause = (typeof PARTY_GOVERNANCE_CAUSES)[number];

/** The single legal primary key of the control row (`ck_bcec_singleton`). */
export const ENFORCEMENT_CONTROL_SINGLETON_ID = 1;

/**
 * The platform-wide control row — ADR-050 §2.1. One row, `id = 1`, for ever.
 *
 * ADR-027 `no_subject_data`: it carries no actor column. Who activated the
 * rollout or who last moved the kill switch is in `admin.admin_audit_log`,
 * pointed at by the two opaque `*AuditId` columns.
 */
@Entity({ name: 'booking_credit_enforcement_control', schema: 'commercial' })
export class BookingCreditEnforcementControlEntity {
  @PrimaryColumn({ name: 'id', type: 'smallint' })
  id!: number;

  @Column({ name: 'rollout_state', type: 'varchar', length: 16 })
  rolloutState!: EnforcementRolloutState;

  @Column({ name: 'activation_generation', type: 'int' })
  activationGeneration!: number;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @Column({ name: 'activation_audit_id', type: 'uuid', nullable: true })
  activationAuditId!: string | null;

  @Column({ name: 'kill_switch_state', type: 'varchar', length: 16 })
  killSwitchState!: KillSwitchState;

  @Column({ name: 'kill_switch_changed_at', type: 'timestamptz', nullable: true })
  killSwitchChangedAt!: Date | null;

  @Column({ name: 'kill_switch_audit_id', type: 'uuid', nullable: true })
  killSwitchAuditId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * One explicit governance fact per seller party — ADR-050 §2.2.
 *
 * `partyId` is OPAQUE (no cross-schema FK), in the same vocabulary the
 * subscription and ledger tables use. Absence of a row means the party is
 * unresolved; presence plus `state` says how an administrator resolved it.
 *
 * ADR-027 `retained`: `recordedByUserId` is subject-linked administrator
 * identity, and its `_user_id` suffix is what makes a dishonest
 * `no_subject_data` claim detectable by the coverage check.
 */
@Entity({ name: 'booking_credit_party_governance', schema: 'commercial' })
export class BookingCreditPartyGovernanceEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid' })
  id!: string;

  @Column({ name: 'party_type', type: 'varchar', length: 16 })
  partyType!: SubscriberPartyType;

  @Column({ name: 'party_id', type: 'uuid' })
  partyId!: string;

  @Column({ name: 'state', type: 'varchar', length: 16 })
  state!: PartyGovernanceState;

  @Column({ name: 'cause', type: 'varchar', length: 32 })
  cause!: PartyGovernanceCause;

  @Column({ name: 'proof_grant_id', type: 'uuid', nullable: true })
  proofGrantId!: string | null;

  @CreateDateColumn({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt!: Date;

  @Column({ name: 'governed_at', type: 'timestamptz', nullable: true })
  governedAt!: Date | null;

  @Column({ name: 'recorded_by_user_id', type: 'uuid', nullable: true })
  recordedByUserId!: string | null;

  @Column({ name: 'recorded_by_label', type: 'varchar', length: 40, nullable: true })
  recordedByLabel!: string | null;

  @Column({ name: 'audit_id', type: 'uuid' })
  auditId!: string;
}

export const ENFORCEMENT_ENTITIES = [BookingCreditEnforcementControlEntity, BookingCreditPartyGovernanceEntity];
