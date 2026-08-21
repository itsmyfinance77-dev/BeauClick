import { IsOptional, IsString } from 'class-validator';

/**
 * `refreshToken` is now OPTIONAL.
 *
 * A browser client sends nothing here -- its token rides in the httpOnly
 * cookie, which the client's own JavaScript cannot read and therefore could
 * not put in a body even if it wanted to. Requiring the field would make the
 * cookie path impossible.
 *
 * Non-browser clients (a future native app, a server-to-server integration)
 * have no cookie jar and still supply it here. The controller resolves the
 * two, prefers the cookie, and applies CSRF protection only to the cookie
 * path -- see AuthController's docblock for why that asymmetry is correct
 * rather than a gap.
 */
export class RefreshDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
