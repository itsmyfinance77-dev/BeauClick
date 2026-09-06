import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

import { MAX_PURCHASABLE_QUANTITY } from '@beauclick/commercial-policy-contract';

/**
 * The credit-purchase request contracts — V3.3 #57 (`#40c-1`), ADR-047 §7.
 *
 * ## One field, and the absences are the contract
 *
 * `quantity` is the only thing a caller may send. No `scheduleKey`,
 * `scheduleVersionId`, `tierId`, `unitPriceToman`, `totalToman`, `currency`,
 * `state`, `lifecycleState`, `subscriptionId`, `partyId`, `professionalId`,
 * `businessId`, `ownerId`, `userId` or `actorId` is declared, so under
 * `forbidNonWhitelisted` every one of them is a **400 rather than a silently
 * stripped value** (`V33-DEC-026` R2, `V33-DEC-019`'s reasoning).
 *
 * The difference matters here more than anywhere else on this surface: a
 * stripped `totalToman` would be ignored by a server that had already computed
 * the price, and read to the caller exactly like a price they chose.
 *
 * ## The bounds are technical
 *
 * `1 .. MAX_PURCHASABLE_QUANTITY` is what an `int4range` can express without
 * overflowing. It is NOT the purchasable range: the commercial minimum and
 * maximum live on the administrator's published schedule version, and a
 * quantity outside them is refused by the pricing engine as
 * `purchase_unavailable`. `V33-DEC-027` R9 forbids a commercial bound existing
 * here.
 */
export class CreditPurchaseQuantityDto {
  /**
   * `@Type(() => Number)` then `@IsInt()`: a JSON string body still arrives as
   * a string, and `"7"` must become `7` before `IsInt` can reject `"7.5"` and
   * `"abc"` honestly. `Min(1)` refuses zero and negatives; `IsInt` refuses
   * fractions and `NaN`.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PURCHASABLE_QUANTITY)
  quantity!: number;
}

/**
 * `GET /me/subscriptions/:workspaceRef/credit-purchases`.
 *
 * One optional opaque cursor and nothing else. No `limit`, because the page
 * size is the server's; no filter, because a filter over another seller's rows
 * is unrepresentable and a filter over your own is a client concern.
 */
export class CreditPurchaseListQueryDto {
  /**
   * Bounded so a malformed value is refused by validation rather than by the
   * base64 decoder. The cursor is opaque and unsigned — it selects nothing a
   * signature would protect, because the workspace is decided before it is
   * read.
   */
  @IsOptional()
  @IsString()
  @Length(1, 256)
  cursor?: string;
}
