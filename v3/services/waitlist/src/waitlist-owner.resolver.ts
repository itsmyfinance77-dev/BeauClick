import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OwnerResolver } from '@beauclick/ownership';

import { WaitlistEntryEntity } from './entities/waitlist-entry.entity';
import { PROFESSIONAL_OWNER_LOOKUP, ProfessionalOwnerLookup } from './ports';

/** The customer who joined -- for decline/remove/accept routes. */
@Injectable()
export class WaitlistEntryOwnerResolver implements OwnerResolver<{ id: string }> {
  constructor(@InjectRepository(WaitlistEntryEntity) private readonly entries: Repository<WaitlistEntryEntity>) {}

  async resolve(sessionUserId: string, params: { id: string }): Promise<string | null> {
    const entry = await this.entries.findOne({ where: { id: params.id } });
    return entry && entry.customerId === sessionUserId ? sessionUserId : null;
  }
}

/** The professional whose queue this is -- for the "my waitlist" professional-side read route. */
@Injectable()
export class WaitlistProfessionalResolver implements OwnerResolver<{ professionalId: string }> {
  constructor(@Inject(PROFESSIONAL_OWNER_LOOKUP) private readonly directory: ProfessionalOwnerLookup) {}

  async resolve(sessionUserId: string, params: { professionalId: string }): Promise<string | null> {
    const ownerId = await this.directory.ownerUserIdFor(params.professionalId);
    return ownerId && ownerId === sessionUserId ? sessionUserId : null;
  }
}
