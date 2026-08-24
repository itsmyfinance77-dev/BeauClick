import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, AuthenticatedUser, PaginatedResult } from '@beauclick/http';
import { ResolveOwner, NotFoundOrNotYoursException } from '@beauclick/ownership';
import { ProviderService } from './provider.service';
import { ServiceOfferingService } from './service-offering.service';
import { ProviderOwnerResolver } from './provider-owner.resolver';
import { CreateProfessionalDto } from './dto/create-professional.dto';
import { UpdateProfessionalDto } from './dto/update-professional.dto';
import { ListProvidersDto } from './dto/list-providers.dto';
import { CreateServiceOfferingDto, UpdateServiceOfferingDto } from './dto/create-service-offering.dto';
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

/**
 * Public reference data: launched cities and the specialty taxonomy.
 *
 * Public because it already is — every city and specialty name appears in
 * search results and on every provider profile page. Withholding the list
 * would protect nothing while making the profile editor impossible to fill in.
 *
 * `V3_DOMAIN_BOUNDARIES.md` §provider names `GET /v1/specialties` in this
 * module's public API and it had never been built; the city equivalent had no
 * route either. The only previous source of both was search's FACETS, which
 * are computed from indexed providers — so on a marketplace with no indexed
 * providers, the pickers were empty and a professional could not name their
 * own city or specialty at all.
 */
@Controller('v1')
export class ReferenceDataController {
  constructor(private readonly providers: ProviderService) {}

  @Public()
  @Get('cities')
  async cities() {
    return (await this.providers.listCities()).map((c) => ({ id: c.id, name: c.name }));
  }

  @Public()
  @Get('specialties')
  async specialties() {
    return (await this.providers.listSpecialties()).map((s) => ({ id: s.id, name: s.name }));
  }
}

/**
 * The caller's OWN professional profile.
 *
 * Separate from `ProviderController` for the same reason `MyFinanceController`
 * is separate from `FinancialAdminController`: this route takes no id at all,
 * so there is nothing to forge and no ownership resolver to get wrong. It is
 * also the bootstrap the whole `/pro` surface needs -- until this existed, a
 * professional had no way to discover their own `professionalId`, so a
 * frontend could not address any of the `/v1/providers/:id/...` routes it
 * owns. `ProviderService.findByOwnerId()` has existed and been tested since
 * Phase 1; this exposes it.
 *
 * `null` rather than 404 when the caller has no profile, mirroring
 * `GET /v1/me/business` exactly: "you have not created one" is a legitimate
 * answer to this question, not a missing resource.
 */
@Controller('v1/me')
export class MyProviderController {
  constructor(private readonly providers: ProviderService) {}

  @Get('provider')
  async myProvider(@CurrentUser() user: AuthenticatedUser) {
    const professional = await this.providers.findByOwnerId(user.userId);
    return professional ? toPublicShape(professional) : null;
  }
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

  /**
   * Edit and soft-delete a catalogue entry.
   *
   * `ServiceOfferingService.update()`/`.remove()` have existed, transactional
   * and event-emitting, since Phase 3 -- they simply had no HTTP route, so a
   * professional could add a service and then never correct its price. These
   * two handlers expose that existing capability; they add none.
   *
   * Two independent ownership checks, deliberately, matching the pattern
   * `BookingController` established: `OwnershipGuard` resolves `:id`'s real
   * owner from the session before the handler runs, and the service methods
   * additionally carry `professionalId` in their own WHERE clause, so another
   * provider's `serviceId` resolves exactly the way a nonexistent one does.
   */
  @ResolveOwner(ProviderOwnerResolver)
  @Patch(':id/services/:serviceId')
  async updateService(
    @Param('id') id: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceOfferingDto,
  ) {
    return this.services.update(serviceId, id, dto);
  }

  @ResolveOwner(ProviderOwnerResolver)
  @Delete(':id/services/:serviceId')
  @HttpCode(204)
  async deleteService(@Param('id') id: string, @Param('serviceId') serviceId: string) {
    const removed = await this.services.remove(serviceId, id);
    // `remove()` returns false for an id that is not this professional's, or
    // is already deleted. Same generic response as everywhere else -- never a
    // distinct shape that would confirm the row exists for someone else.
    if (!removed) throw new NotFoundOrNotYoursException();
  }
}
