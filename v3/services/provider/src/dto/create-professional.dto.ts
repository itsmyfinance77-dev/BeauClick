import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateProfessionalDto {
  @IsString()
  @Length(2, 120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  bio?: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  /**
   * Any UUID version, not v4.
   *
   * This said `IsUUID('4')`, which rejected every id this platform actually
   * issues: `uuidv7()` is the id generator everywhere in V3, and a v7 id fails
   * a v4 check. So a legitimate specialty id -- one the API itself had just
   * returned from `GET /v1/specialties` -- came back as a validation error.
   *
   * Found by driving the real stack in Phase 3 live QA, not by a test: every
   * existing spec passed its own hand-written v4 fixtures.
   */
  @IsUUID('all', { each: true })
  specialtyIds?: string[];
}
