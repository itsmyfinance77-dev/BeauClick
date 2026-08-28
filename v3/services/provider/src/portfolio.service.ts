import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { DomainException } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { MediaDescriptor, MediaObjectEntity, MediaService } from '@beauclick/media';

import { PortfolioItemEntity } from './entities/portfolio-item.entity';
import { ProfessionalEntity } from './entities/professional.entity';
import { ProviderEventsService } from './provider-events.service';

/**
 * How many pieces of work one professional may show.
 *
 * This is the PRODUCT rule -- how large a gallery a visitor is asked to scroll
 * -- and it is deliberately stated here rather than inferred from the media
 * quota, which is a storage bound owned by a different module. They happen to
 * be the same number today; they are not the same rule, and a change to one
 * should not silently move the other.
 */
export const MAX_PORTFOLIO_ITEMS = 40;

export class PortfolioFullException extends DomainException {
  constructor() {
    super(
      'PORTFOLIO_FULL',
      `حداکثر ${MAX_PORTFOLIO_ITEMS} نمونه‌کار می‌توانید داشته باشید. ابتدا یکی را حذف کنید.`,
      HttpStatus.CONFLICT,
    );
  }
}

export interface PortfolioItemView {
  id: string;
  caption: string | null;
  position: number;
  media: MediaDescriptor | null;
  createdAt: string;
}

/**
 * The portfolio, the avatar, and the cover image.
 *
 * THE ONE SECURITY PROPERTY THIS FILE EXISTS TO ESTABLISH: a professional can
 * only ever attach media THEY uploaded. That is not checked here by comparing
 * ids -- it is checked by `MediaService.claimForAttachment`, which re-derives
 * owner, status, and purpose from the media row inside the same transaction.
 * A request naming another professional's media id gets the same
 * `NOT_FOUND_OR_NOT_YOURS` a nonexistent id gets, so the endpoint cannot be
 * used to discover which media ids exist.
 *
 * The route-level ownership check is separate and prior: every mutating route
 * carries `@ResolveOwner(ProviderOwnerResolver)`, so the professional whose
 * portfolio is being edited has already been proved to belong to the session
 * before any of this runs. Two independent checks, because they answer two
 * different questions -- "is this your profile" and "is this your upload".
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(PortfolioItemEntity) private readonly items: Repository<PortfolioItemEntity>,
    @InjectRepository(ProfessionalEntity) private readonly professionals: Repository<ProfessionalEntity>,
    private readonly media: MediaService,
    private readonly events: ProviderEventsService,
  ) {}

  // ------------------------------------------------------------------ read

  async listForProfessional(professionalId: string): Promise<PortfolioItemView[]> {
    const rows = await this.items.find({
      where: { professionalId, deletedAt: IsNull() },
      order: { position: 'ASC' },
    });
    const descriptors = await this.media.describe(null, rows.map((r) => r.mediaId));

    return rows.map((row) => ({
      id: row.id,
      caption: row.caption,
      position: row.position,
      // `null` rather than an error when the object is gone: a single taken-down
      // image must not fail the whole profile page.
      media: descriptors.get(row.mediaId) ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Avatar and cover descriptors for a PAGE of professionals, in one query.
   *
   * The listing route calls this instead of `imagesFor` per row: a 20-item
   * page must not become 20 sequential media lookups, which is the shape that
   * turns a fast listing into a slow one the first time a marketplace has
   * enough providers to notice.
   */
  async imagesForMany(professionals: ProfessionalEntity[]): Promise<Map<string, { avatar: MediaDescriptor | null; cover: MediaDescriptor | null }>> {
    const ids = professionals
      .flatMap((p) => [p.avatarMediaId, p.coverMediaId])
      .filter((id): id is string => !!id);
    const descriptors = await this.media.describe(null, ids);

    const out = new Map<string, { avatar: MediaDescriptor | null; cover: MediaDescriptor | null }>();
    for (const p of professionals) {
      out.set(p.id, {
        avatar: p.avatarMediaId ? descriptors.get(p.avatarMediaId) ?? null : null,
        cover: p.coverMediaId ? descriptors.get(p.coverMediaId) ?? null : null,
      });
    }
    return out;
  }

  /** Avatar and cover descriptors for one professional, for the profile response. */
  async imagesFor(professional: ProfessionalEntity): Promise<{ avatar: MediaDescriptor | null; cover: MediaDescriptor | null }> {
    const ids = [professional.avatarMediaId, professional.coverMediaId].filter((id): id is string => !!id);
    const descriptors = await this.media.describe(null, ids);
    return {
      avatar: professional.avatarMediaId ? descriptors.get(professional.avatarMediaId) ?? null : null,
      cover: professional.coverMediaId ? descriptors.get(professional.coverMediaId) ?? null : null,
    };
  }

  // ----------------------------------------------------------------- write

  async addItem(
    professionalId: string,
    ownerUserId: string,
    input: { mediaId: string; caption: string | null },
  ): Promise<PortfolioItemView> {
    const item = await this.dataSource.transaction(async (manager) => {
      const live = await manager.getRepository(PortfolioItemEntity).count({
        where: { professionalId, deletedAt: IsNull() },
      });
      if (live >= MAX_PORTFOLIO_ITEMS) throw new PortfolioFullException();

      // Ownership, status, and purpose of the upload, all re-derived from the
      // media row. This is the check that stops cross-professional attachment.
      await this.media.claimForAttachment(manager, ownerUserId, input.mediaId, 'portfolio');

      const row = manager.getRepository(PortfolioItemEntity).create({
        id: uuidv7(),
        professionalId,
        mediaId: input.mediaId,
        caption: input.caption,
        position: await this.nextPosition(manager, professionalId),
        deletedAt: null,
      });
      await manager.getRepository(PortfolioItemEntity).save(row);

      // The projection event, in the same transaction as the write. Search
      // learns about the new work only if the work actually committed.
      await this.events.emitMediaChanged(manager, professionalId, await this.mediaSnapshot(manager, professionalId));

      return row;
    });

    const descriptors = await this.media.describe(null, [item.mediaId]);
    return {
      id: item.id,
      caption: item.caption,
      position: item.position,
      media: descriptors.get(item.mediaId) ?? null,
      createdAt: item.createdAt.toISOString(),
    };
  }

  /**
   * The next free slot.
   *
   * `MAX(position) + 1` among LIVE items, so deleting the last item and adding
   * another reuses the slot rather than growing the counter forever. The
   * partial unique index on `(professional_id, position) WHERE deleted_at IS
   * NULL` is what makes a concurrent double-add fail loudly here instead of
   * producing two items in the same slot -- the database decides, not this
   * read.
   */
  private async nextPosition(manager: EntityManager, professionalId: string): Promise<number> {
    const rows: Array<{ next: string | null }> = await manager.query(
      `SELECT MAX(position) + 1 AS next FROM provider.portfolio_items
        WHERE professional_id = $1 AND deleted_at IS NULL`,
      [professionalId],
    );
    return Number(rows[0]?.next ?? 0);
  }

  async removeItem(professionalId: string, ownerUserId: string, itemId: string): Promise<void> {
    const purge = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PortfolioItemEntity);
      const row = await repo.findOne({ where: { id: itemId } });
      // Scoped by professional as well as by id: a valid item id belonging to
      // somebody else must be indistinguishable from one that does not exist.
      if (!row || row.professionalId !== professionalId || row.deletedAt !== null) {
        throw new NotFoundOrNotYoursException();
      }

      await repo.update({ id: itemId }, { deletedAt: () => 'now()' });
      const object = await this.media.markDeletedOwned(manager, ownerUserId, row.mediaId);
      await this.events.emitMediaChanged(manager, professionalId, await this.mediaSnapshot(manager, professionalId));
      return object;
    });

    // Bytes after the commit. If the transaction had rolled back, the item
    // would still be live and its image must still load.
    await this.media.purgeBytes([purge]);
  }

  /**
   * Sets or clears the avatar or cover.
   *
   * Replacing deletes the previous object rather than orphaning it: a
   * superseded avatar is not a fact anybody needs, and leaving it stored would
   * make the quota drift upward with every edit.
   */
  async setProfileImage(
    professionalId: string,
    ownerUserId: string,
    kind: 'avatar' | 'cover',
    mediaId: string | null,
  ): Promise<void> {
    const column = kind === 'avatar' ? 'avatarMediaId' : 'coverMediaId';

    const superseded = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProfessionalEntity);
      const professional = await repo.findOne({ where: { id: professionalId } });
      if (!professional) throw new NotFoundOrNotYoursException();

      if (mediaId !== null) {
        await this.media.claimForAttachment(manager, ownerUserId, mediaId, kind);
      }

      const previousId = professional[column];
      await repo.update({ id: professionalId }, { [column]: mediaId });

      let previous: MediaObjectEntity | null = null;
      if (previousId && previousId !== mediaId) {
        previous = await this.media.markDeletedOwned(manager, ownerUserId, previousId);
      }

      await this.events.emitMediaChanged(manager, professionalId, await this.mediaSnapshot(manager, professionalId));
      return previous;
    });

    if (superseded) await this.media.purgeBytes([superseded]);
  }

  /**
   * The media snapshot the search projection consumes.
   *
   * Read here rather than assembled by the event emitter so that the reindex
   * source and the event carry the SAME shape, from the same query. Two
   * places computing "what images does this professional have" is two places
   * that can disagree about a professional whose avatar was just taken down.
   */
  async mediaSnapshot(
    manager: EntityManager | null,
    professionalId: string,
  ): Promise<{ avatarUrl: string | null; avatarWidth: number | null; avatarHeight: number | null; portfolioCount: number; portfolioPreviewUrls: string[] }> {
    const itemRepo = manager ? manager.getRepository(PortfolioItemEntity) : this.items;
    const proRepo = manager ? manager.getRepository(ProfessionalEntity) : this.professionals;

    const professional = await proRepo.findOne({ where: { id: professionalId } });
    const items = await itemRepo.find({
      where: { professionalId, deletedAt: IsNull() },
      order: { position: 'ASC' },
    });

    const ids = [
      ...(professional?.avatarMediaId ? [professional.avatarMediaId] : []),
      ...items.map((i) => i.mediaId),
    ];
    const descriptors = await this.media.describe(manager, ids);

    const avatar = professional?.avatarMediaId ? descriptors.get(professional.avatarMediaId) ?? null : null;
    // Only objects that are still `stored` produce a descriptor, so a
    // taken-down image drops out of the preview here rather than becoming a
    // broken URL in the search index.
    const previews = items
      .map((i) => descriptors.get(i.mediaId)?.url ?? null)
      .filter((url): url is string => url !== null);

    return {
      avatarUrl: avatar?.url ?? null,
      avatarWidth: avatar?.width ?? null,
      avatarHeight: avatar?.height ?? null,
      portfolioCount: previews.length,
      // Four is what a search result card can show without the payload
      // becoming a second copy of the gallery.
      portfolioPreviewUrls: previews.slice(0, 4),
    };
  }
}
