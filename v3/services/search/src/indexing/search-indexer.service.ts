import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { insertOnce, returningRows } from '@beauclick/events';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import {
  IndexedService,
  IndexStateEntity,
  ProviderDocumentEntity,
  RankingSignalsEntity,
  SignalApplicationEntity,
} from '../entities/search.entities';
import {
  PROVIDER_INDEX_ALIAS,
  PROVIDER_INDEX_MAPPING_VERSION,
  physicalIndexName,
} from '../index/provider-index.definition';
import {
  PROVIDER_REINDEX_SOURCE,
  ProviderReindexSourcePort,
  ProviderSearchDocument,
  SEARCH_ENGINE,
  SearchEnginePort,
} from '../ports';
import { emptySignals, profileCompleteness, RankingSignals, scoreProvider } from '../ranking/ranking';

export interface ProfessionalProjection {
  professionalId: string;
  revision: number;
  displayName: string;
  bio: string | null;
  cityId: string | null;
  cityName: string | null;
  specialtyIds: string[];
  specialtyNames: string[];
  verificationStatus: string;
  isDeleted: boolean;
  updatedAt: Date;
  /** Absent when the event only described the profile; the stored services are then kept. */
  services?: IndexedService[];
}

/** What `ProfessionalMediaChanged` carries (V3.1 Phase C). */
export interface ProfessionalMediaProjection {
  professionalId: string;
  revision: number;
  avatarUrl: string | null;
  avatarWidth: number | null;
  avatarHeight: number | null;
  portfolioCount: number;
  portfolioPreviewUrls: string[];
}

export type RankingSignalName =
  | 'booking_completed'
  | 'booking_cancelled'
  | 'booking_created'
  | 'profile_view';

/**
 * The indexing pipeline.
 *
 * Writes land in PostgreSQL first and are pushed to OpenSearch second, always
 * in that order. That is the design's load-bearing decision, and the reason is
 * failure behaviour: if the engine is down when an event arrives, the
 * projection still commits and the row stays marked dirty, so the outcome is a
 * STALE INDEX that self-heals on the next sweep. Pushing to the engine first
 * would make an engine outage into lost updates -- the projection would never
 * learn what it failed to write.
 *
 * The consequence is that search is eventually consistent with provider data,
 * bounded by the sweep interval, and that is stated rather than hidden. What
 * is NOT eventually consistent is correctness under redelivery or reordering:
 * those are handled exactly, by `revision` and by `signal_applications`.
 */
@Injectable()
export class SearchIndexerService {
  private readonly logger = new Logger('SearchIndexer');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(ProviderDocumentEntity) private readonly documents: Repository<ProviderDocumentEntity>,
    @InjectRepository(RankingSignalsEntity) private readonly signals: Repository<RankingSignalsEntity>,
    @InjectRepository(IndexStateEntity) private readonly indexState: Repository<IndexStateEntity>,
    @Inject(SEARCH_ENGINE) private readonly engine: SearchEnginePort,
    @Optional() @Inject(PROVIDER_REINDEX_SOURCE) private readonly reindexSource: ProviderReindexSourcePort | null = null,
  ) {}

  // ------------------------------------------------------------ projection

  /**
   * Applies a professional-profile change.
   *
   * Returns false when the incoming revision is not newer than the stored one
   * -- a duplicate or an out-of-order delivery. Returning false rather than
   * throwing is deliberate: this is a NORMAL, expected outcome of
   * at-least-once delivery, and throwing would leave the outbox row unpublished
   * and retried forever.
   */
  async applyProfessional(projection: ProfessionalProjection): Promise<boolean> {
    const services = projection.services ?? null;
    const prices = services ? this.priceRange(services) : null;

    // ONE statement. An earlier version inserted a placeholder row and then
    // ran a guarded UPDATE, which was wrong twice over: the placeholder needed
    // a revision the schema's `revision > 0` CHECK rejects, and the two
    // statements left a window in which a concurrent event could observe a
    // half-built document.
    //
    // The `WHERE ... revision < EXCLUDED.revision` on the DO UPDATE is the
    // whole ordering guarantee, and putting it here makes it atomic: a first
    // event and a redelivered older one race for the same row, PostgreSQL
    // serialises them on the row lock, and the older one updates nothing.
    // `affected === 0` therefore means exactly "this was not newer", whether
    // the row already existed or another transaction won the insert.
    const result: Array<unknown> = await this.documents.query(
      `INSERT INTO search.provider_documents (
         professional_id, revision, display_name, bio, city_id, city_name,
         specialty_ids, specialty_names, verification_status, is_deleted,
         services, min_price_toman, max_price_toman,
         source_updated_at, index_dirty_since, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::uuid[], $8::text[], $9, $10,
         COALESCE($11::jsonb, '[]'::jsonb), $12, $13,
         $14, now(), now()
       )
       ON CONFLICT (professional_id) DO UPDATE SET
         revision = EXCLUDED.revision,
         display_name = EXCLUDED.display_name,
         bio = EXCLUDED.bio,
         city_id = EXCLUDED.city_id,
         city_name = EXCLUDED.city_name,
         specialty_ids = EXCLUDED.specialty_ids,
         specialty_names = EXCLUDED.specialty_names,
         verification_status = EXCLUDED.verification_status,
         is_deleted = EXCLUDED.is_deleted,
         -- A profile-only event carries no catalogue, so the stored services
         -- are kept rather than blanked.
         services = COALESCE($11::jsonb, search.provider_documents.services),
         min_price_toman = CASE WHEN $11::jsonb IS NULL THEN search.provider_documents.min_price_toman ELSE $12 END,
         max_price_toman = CASE WHEN $11::jsonb IS NULL THEN search.provider_documents.max_price_toman ELSE $13 END,
         source_updated_at = EXCLUDED.source_updated_at,
         index_dirty_since = now(),
         updated_at = now()
       WHERE search.provider_documents.revision < EXCLUDED.revision
       RETURNING professional_id`,
      [
        projection.professionalId,
        projection.revision,
        projection.displayName,
        projection.bio,
        projection.cityId,
        projection.cityName,
        projection.specialtyIds,
        projection.specialtyNames,
        projection.verificationStatus,
        projection.isDeleted,
        services ? JSON.stringify(services) : null,
        prices?.min ?? null,
        prices?.max ?? null,
        projection.updatedAt,
      ],
    );

    if (result.length === 0) {
      this.logger.debug(
        `Discarded stale revision ${projection.revision} for ${projection.professionalId}`,
      );
      return false;
    }

    await this.rescore(projection.professionalId);
    return true;
  }

  /**
   * Applies an imagery change.
   *
   * An UPDATE, not an upsert, and that is the deliberate half of the design.
   * The columns it touches are disjoint from the ones `applyProfessional`
   * owns, so a profile edit cannot blank an avatar and an avatar change cannot
   * blank a bio -- but a media event for a professional who has NO document
   * yet is dropped rather than allowed to create one. An earlier draft
   * inserted a placeholder row for that case, and that is the same mistake
   * `applyProfessional`'s own docblock records: a document with an empty
   * display name is a live, searchable, wrong result. Media can only be
   * attached to a professional who already exists, so the producer always
   * emits the profile event first; if delivery reorders them badly enough to
   * lose one, `rebuildProjectionFromSource` recovers it -- and it now carries
   * imagery for exactly this reason.
   *
   * `revision <= :incoming` rather than `<`, which is the one place this
   * differs from every other ordering guard here. Two DIFFERENT events never
   * share a revision -- the counter is an atomic increment -- so the equal
   * case arises in exactly two situations, and both want the write to happen:
   * a redelivery of the same event (idempotent, the values are identical),
   * and the rebuild path, which applies a professional and their imagery at
   * one revision because they were read from one snapshot.
   */
  async applyMedia(projection: ProfessionalMediaProjection): Promise<boolean> {
    const result: Array<unknown> = await this.documents.query(
      `UPDATE search.provider_documents
          SET revision = GREATEST(revision, $2),
              avatar_url = $3,
              avatar_width = $4,
              avatar_height = $5,
              portfolio_count = $6,
              portfolio_preview_urls = $7::text[],
              index_dirty_since = now(),
              updated_at = now()
        WHERE professional_id = $1 AND revision <= $2
        RETURNING professional_id`,
      [
        projection.professionalId,
        projection.revision,
        projection.avatarUrl,
        projection.avatarWidth,
        projection.avatarHeight,
        projection.portfolioCount,
        projection.portfolioPreviewUrls,
      ],
    );

    if (returningRows(result).length === 0) {
      this.logger.debug(
        `Discarded media revision ${projection.revision} for ${projection.professionalId} (stale, or no document yet)`,
      );
      return false;
    }

    await this.rescore(projection.professionalId);
    return true;
  }

  /**
   * Applies a ranking-signal increment, exactly once per source event.
   *
   * `eventId` is the outbox row's id -- stable across redeliveries of the same
   * event, distinct between different events. The insert into
   * `signal_applications` is the guard; the increment only runs if that insert
   * won.
   */
  async applySignal(eventId: string, signal: RankingSignalName, professionalId: string, occurredAt: Date): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      // The row already existing means this event has already moved this
      // counter -- a no-op, not an error. `insertOnce` is used because a
      // counter increment is the one projection operation that is NOT
      // naturally idempotent: applying it twice leaves a permanently wrong
      // number with nothing afterwards able to detect it.
      const claimed = await insertOnce(
        manager
          .createQueryBuilder()
          .insert()
          .into(SignalApplicationEntity)
          .values({ eventId, signal, professionalId, appliedAt: new Date() }),
        'event_id',
      );
      if (!claimed) return false;

      await insertOnce(
        manager.createQueryBuilder().insert().into(RankingSignalsEntity).values({ professionalId }),
        'professional_id',
      );

      const column = {
        booking_completed: 'completed_bookings',
        booking_cancelled: 'cancelled_bookings',
        booking_created: 'created_bookings',
        profile_view: 'profile_views',
      }[signal];

      // Counters that also count as "recent activity" -- a profile view is
      // not activity BY the provider, so it deliberately does not.
      const countsAsActivity = signal !== 'profile_view';

      await manager.query(
        `UPDATE search.ranking_signals
            SET ${column} = ${column} + 1,
                recent_activity_count = recent_activity_count + $2,
                last_activity_at = GREATEST(COALESCE(last_activity_at, $3), $3),
                updated_at = now()
          WHERE professional_id = $1`,
        [professionalId, countsAsActivity ? 1 : 0, occurredAt],
      );

      await this.rescore(professionalId, manager.getRepository(ProviderDocumentEntity), manager.getRepository(RankingSignalsEntity));
      return true;
    });
  }

  /** Recomputes the stored ranking score from current signals and marks the row dirty. */
  private async rescore(
    professionalId: string,
    documents: Repository<ProviderDocumentEntity> = this.documents,
    signals: Repository<RankingSignalsEntity> = this.signals,
  ): Promise<void> {
    const doc = await documents.findOne({ where: { professionalId } });
    if (!doc) return;

    const row = await signals.findOne({ where: { professionalId } });
    const signalValues: RankingSignals = {
      ...emptySignals(),
      verified: doc.verificationStatus === 'verified',
      profileCompleteness: profileCompleteness({
        displayName: doc.displayName,
        bio: doc.bio,
        cityId: doc.cityId,
        serviceCount: (doc.services ?? []).length,
      }),
      completedBookings: row?.completedBookings ?? 0,
      cancelledBookings: row?.cancelledBookings ?? 0,
      createdBookings: row?.createdBookings ?? 0,
      profileViews: row?.profileViews ?? 0,
      recentActivityCount: row?.recentActivityCount ?? 0,
      reviewCount: row?.reviewCount ?? 0,
      ratingAvg: row && row.reviewCount > 0 ? row.ratingSum / row.reviewCount : 0,
    };

    const score = scoreProvider(signalValues, await this.platformMeanRating(signals));

    await documents.update(
      { professionalId },
      { rankingScore: score.value, rankingSignalKeys: score.signalKeys, indexDirtySince: new Date() },
    );
  }

  /**
   * The platform-wide mean the Bayesian term shrinks toward.
   *
   * Returns null when nothing has a review, which is the cold-boot state the
   * scorer's own fallback constant exists for. Computed rather than
   * hard-coded, because a hard-coded mean would silently distort every score
   * once real ratings diverge from it.
   */
  private async platformMeanRating(signals: Repository<RankingSignalsEntity>): Promise<number | null> {
    const row = await signals
      .createQueryBuilder('s')
      .select('SUM(s.rating_sum)', 'sum')
      .addSelect('SUM(s.review_count)', 'count')
      .where('s.review_count > 0')
      .getRawOne<{ sum: string | null; count: string | null }>();

    const count = Number(row?.count ?? 0);
    if (!count) return null;
    return Number(row?.sum ?? 0) / count;
  }

  // ----------------------------------------------------------------- engine

  /**
   * Ensures the physical index exists and the alias points at it.
   *
   * Deliberately NOT memoized. An earlier version cached "already ensured for
   * this index name" to avoid two round trips per flush -- and that cache is
   * a correctness bug the moment the engine loses state behind the
   * application's back. A cluster restarted without its data, or an index
   * dropped by an operator, leaves the cached flag saying "the alias is fine"
   * while nothing is listening: documents are then written to an index no
   * alias points at, and every search returns nothing. Reproduced exactly
   * that way when a test wiped the engine between cases.
   *
   * The churn this was meant to avoid is already gone: `flushDirty` returns
   * early when there is no work, so these two calls only happen on a flush
   * that is about to do real writing anyway. Both are idempotent at the
   * engine, so re-issuing them is cheap insurance against a state divergence
   * that would otherwise be silent.
   */
  private async ensureAliasReady(): Promise<string> {
    // A mapping bump has to be acted on BEFORE any write, because the old
    // index's strict mapping rejects the new document shape outright. See
    // `currentPhysicalIndex`'s note on BUG-C-01.
    if (await this.staleMappingVersion()) {
      this.logger.warn(
        `Index mapping version is behind ${PROVIDER_INDEX_MAPPING_VERSION}; rebuilding into a new physical index before writing.`,
      );
      const { physicalIndex } = await this.fullReindex();
      return physicalIndex;
    }

    const physical = await this.currentPhysicalIndex();
    await this.engine.ensureIndex(physical);
    await this.engine.swapAlias(PROVIDER_INDEX_ALIAS, physical);
    return physical;
  }

  /**
   * The current physical index behind the alias, creating state on first use.
   *
   * **BUG-C-01, found while bumping the mapping for Phase C and fixed here.**
   * This method used to return `existing.physicalIndex` unconditionally and
   * never look at `existing.mappingVersion`. That made
   * `PROVIDER_INDEX_MAPPING_VERSION` inert on any deployment that had already
   * created its index: bumping the constant would leave every write going to
   * the OLD physical index, whose mapping is `dynamic: 'strict'` and therefore
   * REJECTS a document carrying a field the old mapping never declared. The
   * failure mode was a permanently failing flush -- not a stale index that
   * self-heals, which is the degradation the rest of this class is designed
   * around, but a hard error on every sweep with the projection silently
   * accumulating dirty rows behind it.
   *
   * It was latent rather than harmless: the constant existed from Phase 3, was
   * documented as "bumped whenever the mapping changes in a way that requires
   * a reindex", and the machinery to act on it (`fullReindex`, which already
   * writes the new version into the state row) was fully built. Nothing
   * connected the two.
   *
   * `staleMappingVersion()` is what connects them. `ensureAliasReady` consults
   * it and rebuilds rather than writing into an index that cannot accept the
   * documents.
   */
  async currentPhysicalIndex(): Promise<string> {
    const existing = await this.indexState.findOne({ where: { indexKey: PROVIDER_INDEX_ALIAS } });
    if (existing) return existing.physicalIndex;

    const physical = physicalIndexName(PROVIDER_INDEX_MAPPING_VERSION);
    await this.indexState
      .createQueryBuilder()
      .insert()
      .values({
        indexKey: PROVIDER_INDEX_ALIAS,
        physicalIndex: physical,
        mappingVersion: PROVIDER_INDEX_MAPPING_VERSION,
      })
      .orIgnore()
      .execute();
    return physical;
  }

  /**
   * True when the live index was built under an older mapping than this
   * build expects.
   *
   * Only ever OLDER. A recorded version NEWER than this constant means a
   * newer application version has already reindexed and an older instance is
   * still running beside it -- rolling back the mapping under it would be far
   * worse than serving slightly incomplete documents, so that case is left
   * alone and logged.
   */
  async staleMappingVersion(): Promise<boolean> {
    const existing = await this.indexState.findOne({ where: { indexKey: PROVIDER_INDEX_ALIAS } });
    if (!existing) return false;
    if (existing.mappingVersion > PROVIDER_INDEX_MAPPING_VERSION) {
      this.logger.warn(
        `Index mapping version ${existing.mappingVersion} is NEWER than this build expects (${PROVIDER_INDEX_MAPPING_VERSION}). ` +
          'Leaving it alone: a newer instance has already reindexed.',
      );
      return false;
    }
    return existing.mappingVersion < PROVIDER_INDEX_MAPPING_VERSION;
  }

  /**
   * Pushes dirty rows to the engine.
   *
   * `indexDirtySince` is captured BEFORE the push and used in the clearing
   * UPDATE's predicate. Without that, an edit arriving mid-push would have its
   * dirty flag cleared by this pass even though the pushed document predates
   * it -- a silently lost update, and the classic bug in this pattern.
   */
  async flushDirty(batchSize = 200): Promise<{ indexed: number; deleted: number }> {
    // Claim the work FIRST. An earlier version created the index and swapped
    // the alias before checking, so the sweep issued two cluster writes every
    // tick even with nothing to do -- at a 2-second interval that is a
    // constant stream of pointless `_aliases` calls and a log line every two
    // seconds that buries everything else. Found by watching the real server's
    // output during live QA.
    const dirty = await this.documents.find({
      where: { indexDirtySince: Not(IsNull()) },
      order: { indexDirtySince: 'ASC' },
      take: batchSize,
    });
    if (dirty.length === 0) return { indexed: 0, deleted: 0 };

    const physical = await this.ensureAliasReady();

    const live = dirty.filter((d) => !d.isDeleted);
    const gone = dirty.filter((d) => d.isDeleted);

    if (live.length > 0) {
      await this.engine.indexDocuments(physical, await this.toSearchDocuments(live));
    }
    for (const row of gone) {
      await this.engine.deleteDocument(physical, row.professionalId);
    }

    const now = new Date();
    for (const row of dirty) {
      await this.documents
        .createQueryBuilder()
        .update(ProviderDocumentEntity)
        .set({ indexDirtySince: null, indexedAt: now })
        .where('professional_id = :id AND index_dirty_since <= :seen', {
          id: row.professionalId,
          seen: row.indexDirtySince,
        })
        .execute();
    }

    return { indexed: live.length, deleted: gone.length };
  }

  /**
   * Full rebuild into a NEW physical index, with an atomic alias swap at the
   * end.
   *
   * Rebuilding in place would leave search serving a half-populated index for
   * the duration -- a customer searching mid-reindex would get a wrong,
   * plausible-looking result page rather than an obvious error. Building
   * beside and swapping means the old index answers every query until the new
   * one is complete.
   */
  async fullReindex(): Promise<{ indexed: number; physicalIndex: string }> {
    const state = await this.indexState.findOne({ where: { indexKey: PROVIDER_INDEX_ALIAS } });
    const currentPhysical = state?.physicalIndex ?? (await this.currentPhysicalIndex());

    // A generation suffix, so a rebuild at the same mapping version still gets
    // a distinct index rather than reusing the one currently serving traffic.
    const generation = Number(currentPhysical.split('-g')[1] ?? 0) + 1;
    const target = `${physicalIndexName(PROVIDER_INDEX_MAPPING_VERSION)}-g${generation}`;

    await this.engine.ensureIndex(target);

    let indexed = 0;
    let after: string | null = null;
    for (;;) {
      const page: ProviderDocumentEntity[] = await this.documents
        .createQueryBuilder('d')
        .where(after ? 'd.professional_id > :after' : '1=1', { after })
        .orderBy('d.professional_id', 'ASC')
        .take(200)
        .getMany();
      if (page.length === 0) break;

      const live = page.filter((d) => !d.isDeleted);
      if (live.length > 0) {
        await this.engine.indexDocuments(target, await this.toSearchDocuments(live));
        indexed += live.length;
      }
      after = page[page.length - 1].professionalId;
    }

    await this.engine.swapAlias(PROVIDER_INDEX_ALIAS, target);
    await this.indexState.update(
      { indexKey: PROVIDER_INDEX_ALIAS },
      {
        physicalIndex: target,
        mappingVersion: PROVIDER_INDEX_MAPPING_VERSION,
        lastFullReindexAt: new Date(),
        lastFullReindexCount: indexed,
      },
    );

    // Every document is now in the new index, so nothing is outstanding.
    await this.documents.update({ indexDirtySince: Not(IsNull()) }, { indexDirtySince: null, indexedAt: new Date() });

    this.logger.log(`Full reindex complete: ${indexed} documents into ${target}`);
    return { indexed, physicalIndex: target };
  }

  /**
   * Rebuilds the PostgreSQL projection from provider-service.
   *
   * The second level of the recovery story: used when the projection itself is
   * lost or was never populated, which is also the migration path for
   * providers that existed before search-service did.
   */
  async rebuildProjectionFromSource(): Promise<number> {
    if (!this.reindexSource) {
      throw new Error(
        'No ProviderReindexSourcePort is bound. The composition root must provide one -- search-service cannot read provider-service directly (ADR-011).',
      );
    }

    let after: string | null = null;
    let count = 0;
    for (;;) {
      const page = await this.reindexSource.fetchProfessionalsForReindex(after, 200);
      if (page.length === 0) break;
      for (const row of page) {
        // `revision` comes from the source, so a rebuild cannot resurrect a
        // document that a newer live event has already superseded.
        await this.applyProfessional(row);
        // Imagery lives in different columns and would otherwise be blanked by
        // a rebuild until each professional next edited something. Applied at
        // the SAME revision, so it is accepted or discarded together with the
        // profile it belongs to.
        await this.applyMedia({ professionalId: row.professionalId, revision: row.revision, ...row.media });
        count += 1;
      }
      after = page[page.length - 1].professionalId;
    }
    return count;
  }

  /** How much work the sweep still has. Surfaced by health so a stuck index is visible. */
  async pendingCount(): Promise<number> {
    return this.documents.count({ where: { indexDirtySince: Not(IsNull()) } });
  }

  /** Rows dirty for longer than `seconds` -- a real staleness alarm, not just a backlog size. */
  async stalePendingCount(seconds: number): Promise<number> {
    return this.documents.count({
      where: { indexDirtySince: LessThan(new Date(Date.now() - seconds * 1000)) },
    });
  }

  /**
   * Builds engine documents for a batch, joining in the ranking signals.
   *
   * Signals are fetched for the WHOLE batch in one query rather than per
   * document: a per-row lookup here would be an N+1 executed once per
   * indexed provider on every sweep and every full reindex, which is exactly
   * the shape GAP-16 flagged in V2's ranking recompute.
   */
  private async toSearchDocuments(rows: ProviderDocumentEntity[]): Promise<ProviderSearchDocument[]> {
    const ids = rows.map((r) => r.professionalId);
    const signalRows = ids.length
      ? await this.signals
          .createQueryBuilder('s')
          .where('s.professional_id IN (:...ids)', { ids })
          .getMany()
      : [];
    const byId = new Map(signalRows.map((s) => [s.professionalId, s]));

    return rows.map((row) => {
      const services = row.services ?? [];
      const signal = byId.get(row.professionalId);
      return {
        professionalId: row.professionalId,
        revision: row.revision,
        displayName: row.displayName,
        bio: row.bio,
        cityId: row.cityId,
        cityName: row.cityName,
        specialtyIds: row.specialtyIds ?? [],
        specialtyNames: row.specialtyNames ?? [],
        verificationStatus: row.verificationStatus,
        isVerified: row.verificationStatus === 'verified',
        services,
        serviceNames: services.map((s) => s.name),
        minPriceToman: row.minPriceToman,
        maxPriceToman: row.maxPriceToman,
        // Zero until a review domain exists to produce them. Carried through
        // honestly rather than defaulted to a flattering value.
        ratingAvg: signal && signal.reviewCount > 0 ? signal.ratingSum / signal.reviewCount : 0,
        reviewCount: signal?.reviewCount ?? 0,
        completedBookings: signal?.completedBookings ?? 0,
        rankingScore: row.rankingScore,
        rankingSignalKeys: row.rankingSignalKeys ?? [],
        avatarUrl: row.avatarUrl ?? null,
        avatarWidth: row.avatarWidth ?? null,
        avatarHeight: row.avatarHeight ?? null,
        portfolioCount: row.portfolioCount ?? 0,
        portfolioPreviewUrls: row.portfolioPreviewUrls ?? [],
        indexedAt: new Date().toISOString(),
      };
    });
  }

  private priceRange(services: IndexedService[]): { min: number; max: number } | null {
    if (services.length === 0) return null;
    const prices = services.map((s) => s.priceToman);
    return { min: Math.min(...prices), max: Math.max(...prices) };
  }
}
