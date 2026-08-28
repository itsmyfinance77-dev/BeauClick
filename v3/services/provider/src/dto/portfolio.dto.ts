import { IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';

export class AddPortfolioItemDto {
  /**
   * A media object THIS caller uploaded, already finalized.
   *
   * Validated as a UUID here and re-derived from the media row in
   * `MediaService.claimForAttachment` -- the format check is convenience, the
   * ownership check is the control.
   */
  @IsUUID()
  mediaId!: string;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  caption?: string;
}

export class SetProfileImageDto {
  /**
   * `null` clears the image; a uuid sets it.
   *
   * Explicitly nullable rather than "omit to clear", because an omitted field
   * and a field the client failed to send are the same request, and clearing
   * somebody's avatar by accident is not a recoverable mistake.
   */
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  mediaId!: string | null;
}

export class AddVerificationEvidenceDto {
  @IsUUID()
  mediaId!: string;
}
