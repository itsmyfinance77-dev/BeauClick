import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { normalizeDigits } from '@beauclick/persian-utils';

export const SEARCH_SORTS = ['relevance', 'ranking', 'price_asc', 'price_desc', 'rating'] as const;

/**
 * Digits arrive from a Persian keyboard as ۱۲۳ and must be understood as
 * numbers, not rejected as non-numeric. `normalizeDigits` is the same
 * utility the display layer uses in reverse -- one implementation of the
 * mapping, used both directions, so the two cannot disagree.
 */
const toNumber = () =>
  Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return undefined;
    const normalized = normalizeDigits(String(value));
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  });

export class SearchProvidersDto {
  /**
   * Capped at 120 characters. Not arbitrary: a query far longer than any real
   * search term is either an accident or an attempt to make the engine do
   * expensive work, and OpenSearch's fuzzy expansion cost grows with term
   * count. Rejecting it outright is cheaper and more honest than truncating,
   * which would silently search for something other than what was asked.
   */
  @IsOptional()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  // Repeated query params arrive as a string when there is exactly one.
  @Transform(({ value }) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]))
  // Capped: a 500-element terms filter is a denial-of-service vector dressed
  // as a legitimate multi-select.
  @Type(() => String)
  specialtyIds?: string[];

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @toNumber()
  @Min(0)
  @Max(5)
  minRating?: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  verifiedOnly?: boolean;

  @IsOptional()
  @IsIn(SEARCH_SORTS)
  sort?: (typeof SEARCH_SORTS)[number];

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  // Deep pagination is genuinely expensive in a distributed search engine
  // (every shard must return `from + size` hits to be merged), and no real
  // customer pages to 200. Capped rather than left open.
  @Max(100)
  page?: number;

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

export class AutocompleteDto {
  @MaxLength(60)
  q!: string;

  @IsOptional()
  @toNumber()
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number;
}

export class RecordProfileViewDto {
  @IsOptional()
  @IsIn(['search', 'direct', 'journey', 'unknown'])
  source?: 'search' | 'direct' | 'journey' | 'unknown';
}
