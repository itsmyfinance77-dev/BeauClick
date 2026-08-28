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
import { AddPortfolioItemDto, SetProfileImageDto } from './dto/portfolio.dto';
import { PortfolioService } from './portfolio.service';
import { ReviewService } from './review.service';
import { Public } from '@beauclick/auth';
import { ProfessionalEntity } from './entities/professional.entity';
import type { MediaDescriptor } from '@beauclick/media';

/**
 * `images` is present on every professional shape from V3.1 Phase C onward,
 * and is `{ avatar: null, cover: null }` rather than absent when a
 * professional has uploaded nothing.
 *
 * Deliberately not an optional field: a consumer that has to distinguish
 * "this response predates imagery" from "this professional has no imagery"
 * ends up writing the same `?? null` at every call site, and one of them
 * eventually forgets. An always-present shape with explicit nulls is an
 * additive change no existing client notices.
 */
function toPublicShape(
  p: ProfessionalEntity,
  images: ProfileImages = EMPTY_IMAGES,
  rating: RatingSummary = EMPTY_RATING,
) {
  return {
    id: p.id,
    displayName: p.displayName,
    bio: p.bio,
    cityId: p.cityId,
    specialties: p.specialties?.map((s) => ({ id: s.id, name: s.name })) ?? [],
    verificationStatus: p.verificationStatus,
    images,
    rating,
    createdAt: p.createdAt,
  };
}

/**
 * The rating aggregate, always present, `{ average: null, count: 0 }` when
 * nobody has reviewed yet.
 *
 * Lives on the professional rather than in the reviews listing's `meta` for
 * two reasons: a profile header needs it without fetching a page of reviews,
 * and `meta` in this codebase means pagination and nothing else. Same
 * always-present-with-explicit-nulls treatment `images` got in Phase C, and
 * for the same reason — a consumer that has to distinguish "this response
 * predates ratings" from "this professional has none" writes the same `?? 0`
 * at every call site until one of them forgets.
 */
interface RatingSummary {
  average: number | null;
  count: number;
}

const EMPTY_RATING: RatingSummary = { average: null, count: 0 };

interface ProfileImages {
  avatar: MediaDescriptor | null;
  cover: MediaDescriptor | null;
}

const EMPTY_IMAGES: ProfileImages = { avatar: null, cover: null };

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
  constructor(
    private readonly providers: ProviderService,
    private readonly portfolio: PortfolioService,
    private readonly reviews: ReviewService,
  ) {}

  @Get('provider')
  async myProvider(@CurrentUser() user: AuthenticatedUser) {
    const professional = await this.providers.findByOwnerId(user.userId);
    if (!professional) return null;
    const ratings = await this.reviews.ratingSummaryFor([professional.id]);
    return toPublicShape(
      professional,
      await this.portfolio.imagesFor(professional),
      ratings.get(professional.id) ?? EMPTY_RATING,
    );
  }
}

/** V3_API_CONTRACT_BLUEPRINT.md §9 example contracts, provider section. */
@Controller('v1/providers')
export class ProviderController {
  constructor(
    private readonly providers: ProviderService,
    private readonly services: ServiceOfferingService,
    private readonly portfolio: PortfolioService,
    private readonly reviews: ReviewService,
  ) {}

  @Public()
  @Get()
  async list(@Query() query: ListProvidersDto): Promise<PaginatedResult<ReturnType<typeof toPublicShape>[]>> {
    const { items, total } = await this.providers.list(query);
    // One batched lookup each for the whole page rather than one per row: a
    // 20-item listing must not become 40 sequential queries.
    const [images, ratings] = await Promise.all([
      this.portfolio.imagesForMany(items),
      this.reviews.ratingSummaryFor(items.map((p) => p.id)),
    ]);
    return {
      value: items.map((p) =>
        toPublicShape(p, images.get(p.id) ?? EMPTY_IMAGES, ratings.get(p.id) ?? EMPTY_RATING),
      ),
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
    const [images, ratings] = await Promise.all([
      this.portfolio.imagesFor(provider),
      this.reviews.ratingSummaryFor([provider.id]),
    ]);
    return toPublicShape(provider, images, ratings.get(provider.id) ?? EMPTY_RATING);
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
    const ratings = await this.reviews.ratingSummaryFor([updated.id]);
    return toPublicShape(updated, await this.portfolio.imagesFor(updated), ratings.get(updated.id) ?? EMPTY_RATING);
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

  // ------------------------------------------------------- portfolio (C)

  /**
   * The gallery. Public, because it is the point: a beauty marketplace where
   * a visitor cannot see a professional's work is the gap `IMAGERY` records.
   */
  @Public()
  @Get(':id/portfolio')
  async listPortfolio(@Param('id') id: string) {
    const provider = await this.providers.findById(id);
    if (!provider) throw new NotFoundOrNotYoursException();
    return this.portfolio.listForProfessional(id);
  }

  /**
   * Attach an already-uploaded, already-finalized media object.
   *
   * Two independent ownership checks, the same pairing every mutating route
   * on this controller uses: `OwnershipGuard` proves `:id` is the session's
   * own professional, and `MediaService.claimForAttachment` proves the media
   * object is the session's own upload. Neither implies the other -- the
   * first would happily attach somebody else's image, the second would
   * happily attach your own image to somebody else's profile.
   */
  @ResolveOwner(ProviderOwnerResolver)
  @Post(':id/portfolio')
  async addPortfolioItem(
    @Param('id') id: string,
    @Body() dto: AddPortfolioItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.portfolio.addItem(id, user.userId, { mediaId: dto.mediaId, caption: dto.caption?.trim() || null });
  }

  @ResolveOwner(ProviderOwnerResolver)
  @Delete(':id/portfolio/:itemId')
  @HttpCode(204)
  async removePortfolioItem(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.portfolio.removeItem(id, user.userId, itemId);
  }

  @ResolveOwner(ProviderOwnerResolver)
  @Patch(':id/avatar')
  @HttpCode(204)
  async setAvatar(
    @Param('id') id: string,
    @Body() dto: SetProfileImageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.portfolio.setProfileImage(id, user.userId, 'avatar', dto.mediaId);
  }

  @ResolveOwner(ProviderOwnerResolver)
  @Patch(':id/cover')
  @HttpCode(204)
  async setCover(
    @Param('id') id: string,
    @Body() dto: SetProfileImageDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.portfolio.setProfileImage(id, user.userId, 'cover', dto.mediaId);
  }
}
