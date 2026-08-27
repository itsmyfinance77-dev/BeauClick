import { ArgumentMetadata, BadRequestException, PipeTransform } from '@nestjs/common';

const UUID_ANY_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A uuid pipe that accepts ANY version.
 *
 * Nest's own `ParseUUIDPipe` defaults to v3/v4/v5, and every id this platform
 * issues is uuidv7. That is not a hypothetical mismatch: `CreateProfessionalDto`
 * hit exactly this in Phase 3 live QA, where a specialty id the API itself had
 * just returned came back as a validation error.
 *
 * The point of validating at all is to reject a path segment that is not an id
 * before it reaches a query, so shape is the right check and version is not.
 */
export class ParseUuidPipeCompat implements PipeTransform<string, string> {
  transform(value: string, _metadata: ArgumentMetadata): string {
    if (!UUID_ANY_VERSION.test(value ?? '')) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'شناسه ارسال‌شده معتبر نیست.' });
    }
    return value;
  }
}
