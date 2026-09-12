import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * The closed scoped-role vocabulary -- V3.3 Story #109 (`#44c`), `V33-DEC-033`
 * R1, extended by exactly one member in Story #111 (`#44e`) under
 * `V33-DEC-030` D4 and ADR-049 section 5.
 *
 * **Exactly two members, on two different axes.**
 *
 * `practitioner_chat` (#109) is the scoped authority whose consumer was blocked
 * at the time: the seller-side chat rule denied a booked practitioner access to
 * their own customer conversation whenever their membership role was `staff`.
 * It is PRACTITIONER-SPECIFIC (`V33-DEC-033` R2): the persisted grant is
 * business-scoped, but the authority reaches only the conversations the
 * grantee's own `business_staff.professional_id` delivered, so a grant of it
 * requires a non-null professional link.
 *
 * `finance_read` (#111) is BUSINESS-SCOPED and READ-ONLY: it lets a consented
 * member -- a bookkeeper, typically, who has no professional profile at all --
 * read the granting business's own finance workspace through the existing
 * workspace-aware finance routes, and nothing else. It confers no ownership,
 * no write of any kind, no other business and no singular-route access
 * (`V33-DEC-020` Ruling 7). A grant of it does NOT require a professional link,
 * because the authority has nothing to do with who delivered a service.
 *
 * The two axes are typed separately so a caller cannot ask the practitioner
 * question about a business-scoped role or vice-versa: the port's practitioner
 * methods take `PractitionerScopedRole`, the business-scoped read takes
 * `BusinessScopedRole`, and `V33-DEC-033` R2's "never business-wide" holds
 * structurally rather than by review.
 *
 * There is deliberately no `owner` (it is `businesses.owner_id`, derived, never
 * stored -- ADR-023), no `location_viewer`, no `location_manager`, no finance
 * WRITE role of any kind (`V33-DEC-020` Ruling 1 stands unweakened), no
 * reception or calendar-mutation role, no `inventory` and no B2B role. A new
 * member requires a later explicit decision **tied to a real consumer**; a
 * vocabulary member that authorizes nothing today is a promise the schema cannot
 * keep.
 */
export const PRACTITIONER_SCOPED_ROLES = ['practitioner_chat'] as const;
export const BUSINESS_SCOPED_ROLES = ['finance_read'] as const;
export const SCOPED_STAFF_ROLES = [...PRACTITIONER_SCOPED_ROLES, ...BUSINESS_SCOPED_ROLES] as const;
export type PractitionerScopedRole = (typeof PRACTITIONER_SCOPED_ROLES)[number];
export type BusinessScopedRole = (typeof BUSINESS_SCOPED_ROLES)[number];
export type ScopedStaffRole = (typeof SCOPED_STAFF_ROLES)[number];

/**
 * Whether a grant of `role` requires the membership to carry a professional
 * link. The ONE place the two axes are told apart on the grant path, so the
 * grant service cannot drift from the vocabulary.
 */
export function requiresProfessionalLink(role: ScopedStaffRole): role is PractitionerScopedRole {
  return (PRACTITIONER_SCOPED_ROLES as readonly string[]).includes(role);
}

/**
 * One scoped authority granted to one consented membership -- V3.3 Story #109
 * (`#44c`), bound by `V33-DEC-033` and ADR-049 section 4.
 *
 * ## Anchored on the membership, never on a user id
 *
 * ADR-049 section 4.2. `membershipId` is `business_staff.id`. That is what keeps
 * consent **structural**: a membership starts `invited` and only the invitee's
 * own authenticated session may move it to `active`, so a grant cannot exist for
 * someone who never accepted. A grant keyed on a user id would quietly restore
 * the hazard ADR-023 closed.
 *
 * ## Business-scoped row, whichever axis the AUTHORITY is on
 *
 * `V33-DEC-033` R2. The row carries `businessId` and no practitioner column.
 * For `practitioner_chat`, practitioner identity is a property of the
 * consent-bearing membership this grant is already anchored on
 * (`business_staff.professional_id`), not a second scope axis. The chat adapter
 * checks that the qualifying booking's `professional_id` equals the
 * membership's, and that the order's snapshotted seller business equals this
 * `businessId`. A grant for one practitioner therefore never exposes another
 * practitioner's conversation in the same salon, with no third generic scope
 * form added. For `finance_read` (#111) the business IS the whole scope: the
 * grant reaches that one business's finance workspace, and the membership's
 * professional link is irrelevant and may be NULL.
 *
 * ## Immutable fact plus one-way revocation
 *
 * A grant is never edited. Revoking stamps `revokedAt` (and `revokedByUserId`,
 * which privacy erasure leaves null because it has no human actor); re-granting
 * inserts a new row. `uq_staff_role_grants_live` admits at most one row per
 * `(membership, role, business)` with `revoked_at IS NULL`, and
 * `tg_staff_role_grants_immutable` refuses every other UPDATE and every DELETE.
 *
 * ## It is never cached
 *
 * ADR-049 section 4.3. Nothing here is copied into a JWT claim, a session or a
 * memo. Authority is re-read on every request, so revocation is effective on the
 * **next** request and a stale token carrying a valid base capability is refused.
 */
@Entity({ name: 'staff_role_grants', schema: 'business' })
@Index('ix_staff_role_grants_live_membership', ['membershipId'], { where: 'revoked_at IS NULL' })
@Index('uq_staff_role_grants_live', ['membershipId', 'role', 'businessId'], {
  unique: true,
  where: 'revoked_at IS NULL',
})
export class StaffRoleGrantEntity {
  @PrimaryColumn('uuid')
  id!: string;

  /** References business.business_staff.id. Same-schema, non-cascading, and half of the composite same-business FK. */
  @Column({ type: 'uuid' })
  membershipId!: string;

  /** The other half of the composite FK: the membership and the grant must name the same business. */
  @Column({ type: 'uuid' })
  businessId!: string;

  @Column({ type: 'varchar', length: 24 })
  role!: ScopedStaffRole;

  /** The live business owner who granted. Never a manager, never the grantee. */
  @Column({ type: 'uuid' })
  grantedByUserId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt!: Date;

  /** Null while live; null too when privacy erasure revoked it, which has no human actor. */
  @Column({ type: 'uuid', nullable: true })
  revokedByUserId!: string | null;

  /** Null exactly while the grant is live. */
  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
