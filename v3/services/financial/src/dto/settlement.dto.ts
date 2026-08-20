import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class PartyQueryDto {
  @IsIn(['professional', 'business'])
  partyType!: 'professional' | 'business';

  @IsUUID()
  partyId!: string;
}

export class CreateSettlementDto {
  @IsIn(['professional', 'business'])
  partyType!: 'professional' | 'business';

  @IsUUID()
  partyId!: string;

  /**
   * Note there is no `amount` field. The operator chooses WHICH orders to
   * settle; the system computes HOW MUCH from each order's real outstanding
   * balance. A free-typed amount could disagree with every real financial
   * fact, which is exactly the class of error a settlement UI must not be
   * able to introduce.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  orderIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(60)
  method?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ReverseSettlementDto {
  @IsString()
  @MaxLength(255)
  reason!: string;
}
