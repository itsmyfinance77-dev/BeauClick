import { Body, Controller, Get, InternalServerErrorException, Patch } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUser, AuthenticatedUser } from '@beauclick/http';
import { UserEntity } from '../entities/user.entity';
import { UpdateMeDto } from './dto/update-me.dto';
import { capabilitiesForRoles } from '../rbac/capabilities';

/**
 * V3_API_CONTRACT_BLUEPRINT.md example contracts: GET/PATCH /v1/me.
 * Inherently self-scoped by construction -- identity is read from the JWT
 * (@CurrentUser), never from a route param, so there is no ownership
 * resolver needed here (nothing to forge: there is no :id in the URL).
 */
@Controller('v1/me')
export class MeController {
  constructor(@InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>) {}

  @Get()
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    const record = await this.userRepo.findOne({ where: { id: user.userId } });
    if (!record) throw new InternalServerErrorException(); // JWT verified but user row missing -- a real invariant violation, not a normal 404 path.
    return {
      id: record.id,
      phone: record.phone,
      displayName: record.displayName,
      roles: record.roles,
      capabilities: capabilitiesForRoles(record.roles),
    };
  }

  @Patch()
  async updateMe(@Body() dto: UpdateMeDto, @CurrentUser() user: AuthenticatedUser) {
    const record = await this.userRepo.findOneOrFail({ where: { id: user.userId } });
    if (dto.displayName !== undefined) record.displayName = dto.displayName;
    const saved = await this.userRepo.save(record);
    return { id: saved.id, phone: saved.phone, displayName: saved.displayName, roles: saved.roles };
  }
}
