import { IsIn, IsString, Length, Matches } from 'class-validator';

export class VerifyOtpDto {
  @Matches(/^(\+98|0098|98|0)?9\d{9}$/, { message: 'شماره موبایل نامعتبر است.' })
  phone!: string;

  @IsString()
  @Length(6, 6)
  code!: string;

  @IsIn(['login', 'change_phone', 'confirm_deletion'])
  purpose: 'login' | 'change_phone' | 'confirm_deletion' = 'login';
}
