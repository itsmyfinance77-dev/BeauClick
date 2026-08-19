import { IsIn, Matches } from 'class-validator';

/** Iranian mobile shape after canonicalization: 9 + 9 digits (see phone.util.ts). */
export class RequestOtpDto {
  @Matches(/^(\+98|0098|98|0)?9\d{9}$/, { message: 'شماره موبایل نامعتبر است.' })
  phone!: string;

  @IsIn(['login', 'change_phone', 'confirm_deletion'])
  purpose: 'login' | 'change_phone' | 'confirm_deletion' = 'login';
}
