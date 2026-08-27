import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { normalizeDigits } from '@beauclick/persian-utils';

const foldDigits = () => Transform(({ value }) => (typeof value === 'string' ? normalizeDigits(value) : value));

/** DEVELOPMENT-ONLY. The QA phone to establish a session for; must be on the configured allow-list. */
export class DevQaLoginDto {
  @foldDigits()
  @Matches(/^(\+98|0098|98|0)?9\d{9}$/, { message: 'شماره موبایل نامعتبر است.' })
  phone!: string;
}
