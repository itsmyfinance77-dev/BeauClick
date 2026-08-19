import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser, PaginatedResult } from '@beauclick/http';
import { ResolveOwner, NotFoundOrNotYoursException } from '@beauclick/ownership';
import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';
import { ListProvidersDto } from './dto/list-providers.dto';
import { CreateServiceOfferingDto } from './dto/create-service-offering.dto';
import { Public } from '@beauclick/auth';
import { ProfessionalEntity } from './entities/professional.entity';

function toPublicShape(p: ProfessionalEntity) {
  return {
    id: p.id,
    displayName: p.displayName,
    bio: p.bio,
    cityId: p.cityId,
    specialties: p.specialties?.map((s) => ({ id: s.id, name: s.name })) ?? [],
    verificationStatus: p.verificationStatus,
    createdAt: p.createdAt,
  };
}

/** V3_API_CONTRACT_BLUEPRINT.md §9 example contracts, provider section. */
@Controller('v1/providers')
export class ProviderController {
  constructor(
    private readonly providers: ProviderService,
    private readonly services: ServiceOfferingService,
  ) {}

  @Public()
  @Get()
  async list(@Query() query: ListProvidersDto): Promise<PaginatedResult<ReturnType<typeof toPublicShape>[]>> {
    const { items, total } = await this.providers.list(query);
    return {
      value: items.map(toPublicShape),
      meta: { pagination: { page: query.page, limit: query.limit, total } },
    };
  }

  @Public()
  @Get(':id')
  async getOne(@Param('id') id: string) {
    const provider = await this.providers.findById(id);
    // Identical response for "doesn't exist" as OwnershipGuard gives for
    // "exists but isn't yours" elsewhere -- consistent NOT_FOUND_OR_NOT_YOURS
    // shape even on a route with no ownership check at all.
    if (!provider) throw new NotFoundOrNotYoursException();
    return toPublicShape(provider);
  }

  @Post()
  async create(@Body() dto: CreateProfessionalDto, @CurrentUser() user: AuthenticatedUser) {
    // ownerId is user.userId, from the verified JWT -- never from dto.
    const created = await this.providers.create(user.userId, dto);
    return toPublicShape(created);
  }

  @ResolveOwner(ProviderOwnerResolver)
  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateProfessionalDto, @CurrentUser() user: AuthenticatedUser) {
    const updated = await this.providers.update(id, user.userId, dto);
    return toPublicShape(updated);
  }

  @Public()
  @Get(':id/services')
  async listServices(@Param('id') id: string) {
    const provider = await this.providers.findById(id);
    if (!provider) throw new NotFoundOrNotYoursException();
    return this.services.listForProfessional(id);
  }

  @ResolveOwner(ProviderOwnerResolver)
  @Post(':id/services')
  async createService(@Param('id') id: string, @Body() dto: CreateServiceOfferingDto) {
    return this.services.create(id, dto);
  }
}
