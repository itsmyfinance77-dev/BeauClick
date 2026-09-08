import { IsIn, IsString, Length } from 'class-validator';
import { BUSINESS_STAFF_ROLES, BusinessStaffRole } from '../entities/business-staff.entity';
import { SCOPED_STAFF_ROLES, ScopedStaffRole } from '../entities/staff-role-grant.entity';

/**
 * Invite a colleague by phone number -- V3.3 Story #109 (`#44c`),
 * `V33-DEC-030` D5 and `V33-DEC-033` R4.
 *
 * ## What replaced what, and why there is no parallel path
 *
 * This DTO used to be `{ userId: @IsUUID, professionalId?: @IsUUID, role }`. It
 * required the owner to already know the invitee's identity UUID, which made
 * every scoped role administratively unusable -- and it handed the owner an
 * oracle: submit a UUID, read the difference between a success and a refusal.
 * `V33-DEC-033` R4 **replaces** it rather than deprecating it alongside, because
 * a retained UUID endpoint keeps that oracle working for as long as it exists.
 *
 * `professionalId` is gone with `userId`: the membership's professional link is
 * resolved **server-side** from the invited account's own profile
 * (`V33-DEC-033` R2), so the inviter neither learns nor asserts it.
 *
 * ## `role` here is the MEMBERSHIP role, not a scoped grant
 *
 * It stays exactly `manager | staff` (`BUSINESS_STAFF_ROLES`). Scoped authority
 * is a separate, separately-granted thing with its own one-member vocabulary;
 * conflating the two is what `V33-DEC-030` refused when it declined to widen
 * `business_staff.role`.
 *
 * ## The phone is validated only for shape here
 *
 * Canonicalisation is the identity domain's rule and is applied server-side
 * through a port; this DTO refuses only what is not plausibly a phone string at
 * all. A malformed phone is the one case that may answer `400` rather than the
 * uniform `202` -- consistent with the platform's existing public phone
 * validation, which already 400s a malformed number on the OTP surface.
 */
export class InviteStaffByPhoneDto {
  /**
   * Bounded, but deliberately not pattern-matched here.
   *
   * `canonicalizePhone` accepts local `09…`, `+98…`, `0098…`, `98…` and
   * Persian/Arabic-Indic digits. Re-stating that grammar in a regex would be a
   * second implementation of one rule, and the two would drift -- so the DTO
   * checks only that a bounded string arrived and the identity port decides
   * whether it is a phone number.
   */
  @IsString()
  @Length(1, 32)
  phone!: string;

  @IsIn(BUSINESS_STAFF_ROLES)
  role!: BusinessStaffRole;
}

export class ChangeStaffRoleDto {
  @IsIn(BUSINESS_STAFF_ROLES)
  role!: BusinessStaffRole;
}

/**
 * The scoped-role command body -- one closed literal and nothing else.
 *
 * The membership is named in the path, the business is named in the path and
 * ownership-guarded, and the actor comes from the session. There is deliberately
 * no owner, user, phone, professional or business id here: the whitelist pipe
 * rejects any extra field with a `400`, so those are not merely unused but
 * unaccepted.
 */
export class ScopedStaffRoleDto {
  @IsIn(SCOPED_STAFF_ROLES)
  role!: ScopedStaffRole;
}
