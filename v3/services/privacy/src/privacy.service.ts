import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';

import { DomainException } from '@beauclick/http';
import { NotFoundOrNotYoursException } from '@beauclick/ownership';
import { returningRows } from '@beauclick/events';
import { AdminAuditService } from '@beauclick/audit';
import {
  EVENT_CONTRACT_REGISTRY,
  EventContractRegistry,
  DataErasureCancelled,
  DataErasureCompleted,
  DataErasureRequested,
  DataExportCompleted,
  DataExportRequested,
  emitContractEvent,
} from '@beauclick/event-contracts';
import {
  SUBJECT_DATA_CONTRACTS,
  SubjectDataContract,
  SubjectErasureOutcome,
  tombstoneFor,
} from '@beauclick/subject-data';

import { DataRequestEntity, DataRequestKind } from './entities/data-request.entity';
import { ExportPayloadEntity } from './entities/export-payload.entity';
import { PrivacyOutboxEntity } from './entities/privacy-outbox.entity';
import { PrivacyConfig } from './privacy.config';

/** The document version, so a consumer of an old export can tell what shape it is. */
export const EXPORT_DOCUMENT_VERSION = 1;

export class PrivacyRequestConflictException extends DomainException {
  constructor(message: string) {
    super('CONFLICT', message, HttpStatus.CONFLICT);
  }
}

export class ExportNotAvailableException extends DomainException {
  constructor() {
    super('NOT_FOUND_OR_NOT_YOURS', 'این درخواست یافت نشد.', HttpStatus.NOT_FOUND);
  }
}

export interface ExportDocument {
  documentVersion: number;
  subjectUserId: string;
  generatedAt: string;
  /** `moduleKey.sectionKey` -> rows. Flat, so a subject reading the JSON can find things. */
  sections: Record<string, { description: string; rows: ReadonlyArray<Record<string, unknown>> }>;
  /** Everything the platform deliberately kept, and why. Part of the document because the subject is entitled to know. */
  retained: Array<{ module: string; table: string; reason: string }>;
}

/**
 * The privacy orchestrator (`GAP-22` / `GAP-21`).
 *
 * It owns the REQUESTS and nothing else. It does not know that booking or
 * loyalty exist, holds no repository belonging to another schema, and reads no
 * table outside `privacy.*`. Everything it does to a subject's data it does by
 * asking each module's own `SubjectDataContract` -- see that port for why the
 * direction is inverted, and `coverage.ts` for the boot assertion that stops a
 * module quietly not registering.
 *
 * THE TWO PROPERTIES THIS CLASS IS RESPONSIBLE FOR:
 *
 *  1. **An export is delivered to the subject and to nobody else.** There is
 *     no route on this service that takes a user id, and no administrative
 *     path that reaches `export_payloads` at all. The subject is always
 *     `@CurrentUser()`.
 *
 *  2. **Erasure is atomic across every module.** One transaction covers all
 *     fourteen contracts plus the request row plus the event, so there is no
 *     half-erased subject for a retry to reason about. Fourteen sequential
 *     commits would leave a subject whose identity was destroyed but whose
 *     reviews still carry their text, and no way to tell how far it got.
 */
@Injectable()
export class PrivacyService {
  private readonly logger = new Logger('PrivacyService');

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(DataRequestEntity) private readonly requests: Repository<DataRequestEntity>,
    @InjectRepository(ExportPayloadEntity) private readonly payloads: Repository<ExportPayloadEntity>,
    private readonly config: PrivacyConfig,
    private readonly audit: AdminAuditService,
    @Inject(EVENT_CONTRACT_REGISTRY) private readonly contracts: EventContractRegistry,
    @Optional()
    @Inject(SUBJECT_DATA_CONTRACTS)
    private readonly modules: SubjectDataContract[] = [],
  ) {}

  // ------------------------------------------------------------- requests

  /**
   * Opens a request of either kind.
   *
   * The "one open request per subject per kind" rule is enforced by the
   * partial UNIQUE index, not by the read below. The read exists only to
   * produce a useful message in the common, non-concurrent case; the index is
   * what actually refuses the second of two simultaneous taps.
   */
  private async open(subjectUserId: string, kind: DataRequestKind): Promise<DataRequestEntity> {
    const now = new Date();
    const executeAfter =
      kind === 'erasure' ? new Date(now.getTime() + this.config.erasureGraceHours * 3_600_000) : null;

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(DataRequestEntity);
      const request = repo.create({
        id: uuidv7(),
        subjectUserId,
        kind,
        status: 'pending',
        requestedAt: now,
        executeAfter,
        expiresAt: null,
        completedAt: null,
        cancelledAt: null,
        cancelledBy: null,
        failureCode: null,
        outcome: null,
      });

      try {
        await repo.insert(request);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new PrivacyRequestConflictException(
            kind === 'export'
              ? 'یک درخواست دریافت اطلاعات در حال انجام دارید.'
              : 'یک درخواست حذف حساب در حال انجام دارید.',
          );
        }
        throw error;
      }

      if (kind === 'export') {
        await emitContractEvent(this.contracts, manager, PrivacyOutboxEntity, DataExportRequested, {
          aggregateId: request.id,
          payload: {
            requestId: request.id,
            subjectUserId,
            requestedAt: now.toISOString(),
          },
        });
      } else {
        await emitContractEvent(this.contracts, manager, PrivacyOutboxEntity, DataErasureRequested, {
          aggregateId: request.id,
          payload: {
            requestId: request.id,
            subjectUserId,
            // Non-null for erasure by construction (and by CHECK constraint).
            executeAfter: (executeAfter as Date).toISOString(),
            requestedAt: now.toISOString(),
          },
        });
      }

      // The permanent record, in the SAME transaction as the request.
      //
      // Recorded even though neither route is capability-gated, and that is a
      // deliberate widening of `admin.admin_audit_log`'s remit: it is where
      // "why does this account no longer exist" gets answered, and the answer
      // must exist whether the actor was an operator or the account's own
      // owner. The subject is both actor and target here -- which is exactly
      // what the row says.
      await this.audit.record(manager, {
        actorUserId: subjectUserId,
        action: kind === 'export' ? 'privacy.export_requested' : 'privacy.erasure_requested',
        targetType: 'data_request',
        targetId: request.id,
        after: { kind, status: 'pending', executeAfter: executeAfter?.toISOString() ?? null },
        reason: 'self-service privacy request',
      });

      return request;
    });
  }

  requestExport(subjectUserId: string): Promise<DataRequestEntity> {
    return this.open(subjectUserId, 'export');
  }

  requestErasure(subjectUserId: string): Promise<DataRequestEntity> {
    return this.open(subjectUserId, 'erasure');
  }

  /**
   * One of the subject's own requests.
   *
   * Scoped by BOTH id and subject, so another user's request id resolves
   * exactly the way a nonexistent one does -- `V3_SECURITY_MODEL.md` §3's
   * must-not-leak-existence rule. Without the subject clause this route would
   * be an oracle for which request ids exist and what state they are in.
   */
  async findOwn(subjectUserId: string, requestId: string): Promise<DataRequestEntity> {
    const request = await this.requests.findOne({ where: { id: requestId, subjectUserId } });
    if (!request) throw new NotFoundOrNotYoursException();
    return request;
  }

  async listOwn(subjectUserId: string): Promise<DataRequestEntity[]> {
    return this.requests.find({ where: { subjectUserId }, order: { requestedAt: 'DESC' }, take: 50 });
  }

  /**
   * The subject cancels their own erasure inside the grace window.
   *
   * A compare-and-swap on `status = 'pending'`, which closes both races that
   * matter: two cancel taps produce one cancellation, and a cancel that
   * arrives while the sweep has already claimed the request (`processing`)
   * loses -- correctly, because at that point the erasure is in flight and
   * "cancelled" would be a lie.
   *
   * Nothing is restored here because nothing was destroyed. That is the whole
   * argument for the grace window rather than erase-then-undo: see the
   * migration's header.
   */
  async cancelErasure(subjectUserId: string, requestId: string): Promise<DataRequestEntity> {
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const claimed = await manager
        .createQueryBuilder()
        .update(DataRequestEntity)
        .set({ status: 'cancelled', cancelledAt: now, cancelledBy: subjectUserId })
        .where(
          "id = :id AND subject_user_id = :subjectUserId AND kind = 'erasure' AND status = 'pending'",
          { id: requestId, subjectUserId },
        )
        .execute();

      if (claimed.affected !== 1) {
        // Deliberately does not distinguish "no such request", "not yours",
        // "already cancelled", and "already executing". The first two must not
        // be distinguishable at all; the last two are genuinely the same
        // answer to the caller -- this request is no longer cancellable.
        throw new NotFoundOrNotYoursException();
      }

      await emitContractEvent(this.contracts, manager, PrivacyOutboxEntity, DataErasureCancelled, {
        aggregateId: requestId,
        payload: { requestId, subjectUserId, cancelledAt: now.toISOString() },
      });

      await this.audit.record(manager, {
        actorUserId: subjectUserId,
        action: 'privacy.erasure_cancelled',
        targetType: 'data_request',
        targetId: requestId,
        before: { status: 'pending' },
        after: { status: 'cancelled' },
        reason: 'cancelled by the subject inside the grace window',
      });

      return manager.getRepository(DataRequestEntity).findOneOrFail({ where: { id: requestId } });
    });
  }

  // --------------------------------------------------------------- export

  /**
   * Generates the document for one claimed export request.
   *
   * The claim happens FIRST, as a status CAS, and the expensive read happens
   * only if it succeeded. Two sweeps running against one database -- which is
   * the normal state of a multi-instance deployment -- would otherwise both
   * assemble the same subject's entire data set and both write a payload row.
   */
  async generateExport(requestId: string): Promise<boolean> {
    const claimed = await this.claim(requestId, 'pending', 'processing');
    if (!claimed) return false;

    try {
      const document = await this.assembleDocument(claimed.subjectUserId);
      const serialized = JSON.stringify(document);
      const expiresAt = new Date(Date.now() + this.config.exportTtlHours * 3_600_000);
      const completedAt = new Date();

      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(ExportPayloadEntity).save(
          manager.getRepository(ExportPayloadEntity).create({
            requestId,
            document: document as unknown as Record<string, unknown>,
            byteSize: String(Buffer.byteLength(serialized, 'utf8')),
            checksumSha256: createHash('sha256').update(serialized).digest('hex'),
            generatedAt: completedAt,
          }),
        );

        await manager
          .createQueryBuilder()
          .update(DataRequestEntity)
          .set({ status: 'ready', expiresAt, completedAt })
          .where("id = :id AND status = 'processing'", { id: requestId })
          .execute();

        await emitContractEvent(this.contracts, manager, PrivacyOutboxEntity, DataExportCompleted, {
          aggregateId: requestId,
          payload: {
            requestId,
            subjectUserId: claimed.subjectUserId,
            expiresAt: expiresAt.toISOString(),
            completedAt: completedAt.toISOString(),
          },
        });
      });

      return true;
    } catch (error) {
      // The subject must be able to see that it failed rather than watching a
      // request sit in `processing` forever. A stable code, never the driver's
      // message -- which routinely embeds the data this row must not carry.
      await this.requests.update({ id: requestId }, { status: 'failed', failureCode: 'export_generation_failed' });
      this.logger.error(`Export generation failed for request ${requestId}`, error as Error);
      return false;
    }
  }

  /**
   * Asks every registered module for the subject's data, in one snapshot.
   *
   * One transaction, one consistent read. Fourteen independent reads could
   * contain a booking that was cancelled halfway through the assembly and a
   * timeline that never learned about it -- a document that describes a state
   * the platform was never in.
   */
  async assembleDocument(subjectUserId: string): Promise<ExportDocument> {
    return this.dataSource.transaction(async (manager) => {
      const sections: ExportDocument['sections'] = {};
      const retained: ExportDocument['retained'] = [];

      for (const module of this.modules ?? []) {
        for (const claim of module.tables) {
          if (claim.disposition === 'retained') {
            retained.push({ module: module.moduleKey, table: claim.table, reason: claim.reason ?? 'unstated' });
          }
        }

        const produced = await module.exportSubjectData(manager, subjectUserId);
        for (const section of produced) {
          sections[`${module.moduleKey}.${section.key}`] = {
            description: section.description,
            rows: section.rows,
          };
        }
      }

      return {
        documentVersion: EXPORT_DOCUMENT_VERSION,
        subjectUserId,
        generatedAt: new Date().toISOString(),
        sections,
        retained,
      };
    });
  }

  /**
   * The subject's own document.
   *
   * Four refusals collapse into one: no such request, somebody else's request,
   * not generated yet, and expired. A caller who can tell them apart has an
   * oracle over other people's privacy requests.
   */
  async downloadOwnExport(
    subjectUserId: string,
    requestId: string,
  ): Promise<{ document: Record<string, unknown>; byteSize: number; checksum: string; expiresAt: Date }> {
    const request = await this.requests.findOne({ where: { id: requestId, subjectUserId, kind: 'export' } });
    if (!request || request.status !== 'ready') throw new ExportNotAvailableException();
    // Checked against the clock as well as against status: the sweep is what
    // moves a `ready` export to `expired`, and between the expiry instant and
    // the next sweep tick the row still says `ready`. Trusting status alone
    // would make the TTL "72 hours, plus however long the sweep takes".
    if (request.expiresAt && request.expiresAt.getTime() <= Date.now()) throw new ExportNotAvailableException();

    const payload = await this.payloads.findOne({ where: { requestId } });
    if (!payload) throw new ExportNotAvailableException();

    return {
      document: payload.document,
      byteSize: Number(payload.byteSize),
      checksum: payload.checksumSha256,
      expiresAt: request.expiresAt as Date,
    };
  }

  // -------------------------------------------------------------- erasure

  /**
   * Executes one due erasure.
   *
   * ONE TRANSACTION covers every module, the request row, and the event. The
   * alternative -- a commit per module -- has no acceptable failure mode: a
   * subject whose identity is destroyed but whose free text survives is both
   * un-notifiable and un-retryable, because nothing records how far it got.
   *
   * The `financial` DataSource is deliberately outside this transaction and
   * that is not a gap: `financial` retains everything by obligation and
   * performs no writes during erasure (ADR-017 gives the application role no
   * UPDATE on the ledger in any case, so it could not).
   */
  async executeErasure(requestId: string): Promise<SubjectErasureOutcome[] | null> {
    const claimed = await this.claim(requestId, 'pending', 'processing');
    if (!claimed) return null;

    try {
      return await this.dataSource.transaction(async (manager) => {
        const completedAt = new Date();
        const tombstone = tombstoneFor(claimed.subjectUserId, completedAt);
        const outcomes: SubjectErasureOutcome[] = [];

        for (const module of this.modules ?? []) {
          outcomes.push(await module.eraseSubjectData(manager, claimed.subjectUserId, tombstone));
        }

        await manager
          .createQueryBuilder()
          .update(DataRequestEntity)
          .set({
            status: 'completed',
            completedAt,
            // Counts and retention reasons only. This row survives the erasure
            // it records, so anything on it survives too.
            outcome: {
              modules: outcomes.map((o) => ({
                module: o.moduleKey,
                anonymized: o.anonymized,
                deleted: o.deleted,
                retained: o.retained,
              })),
            },
          })
          .where("id = :id AND status = 'processing'", { id: requestId })
          .execute();

        await emitContractEvent(this.contracts, manager, PrivacyOutboxEntity, DataErasureCompleted, {
          aggregateId: requestId,
          payload: {
            requestId,
            subjectUserId: claimed.subjectUserId,
            // Only the modules that actually touched something. A module that
            // had nothing to do is a real answer, but listing it here would
            // make the event look like more happened than did.
            modules: outcomes.filter((o) => o.anonymized > 0 || o.deleted > 0).map((o) => o.moduleKey),
            completedAt: completedAt.toISOString(),
          },
        });

        // The erasure's own record, in its transaction. `actorUserId` is the
        // subject: the platform executed a request the subject made, and
        // attributing it to a system principal would lose that.
        await this.audit.record(manager, {
          actorUserId: claimed.subjectUserId,
          action: 'privacy.erasure_executed',
          targetType: 'user',
          targetId: claimed.subjectUserId,
          // Counts, never content -- this row is append-only and outlives the
          // erasure by design, so anything on it survives the erasure too.
          after: {
            modules: outcomes.length,
            anonymized: outcomes.reduce((sum, o) => sum + o.anonymized, 0),
            deleted: outcomes.reduce((sum, o) => sum + o.deleted, 0),
          },
          reason: `data_request ${requestId}`,
        });

        return outcomes;
      });
    } catch (error) {
      await this.requests.update({ id: requestId }, { status: 'failed', failureCode: 'erasure_failed' });
      this.logger.error(`Erasure failed for request ${requestId}`, error as Error);
      throw error;
    }
  }

  // ----------------------------------------------------------------- sweep

  /**
   * Erasures whose grace window has closed.
   *
   * Returns the SUBJECT alongside the request id, because the caller needs it
   * before the erasure runs: media has to read which stored objects will need
   * purging while their rows still say `stored`, and afterwards they are
   * indistinguishable from objects deleted last month.
   */
  async dueErasures(limit = 20): Promise<Array<{ id: string; subjectUserId: string }>> {
    const rows: Array<{ id: string; subject_user_id: string }> = await this.requests.query(
      `SELECT id, subject_user_id FROM privacy.data_requests
        WHERE kind = 'erasure' AND status = 'pending' AND execute_after <= now()
        ORDER BY execute_after
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ id: r.id, subjectUserId: r.subject_user_id }));
  }

  /** Exports waiting to be generated. */
  async pendingExports(limit = 20): Promise<string[]> {
    const rows: Array<{ id: string }> = await this.requests.query(
      `SELECT id FROM privacy.data_requests
        WHERE kind = 'export' AND status = 'pending'
        ORDER BY requested_at
        LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Destroys expired export documents.
   *
   * The DELETE runs against `export_payloads` first and the status update
   * second, in that order and in one transaction. Reversed, a crash between
   * them would leave a request marked `expired` -- so no route will serve it,
   * and no sweep will look at it again -- while a full copy of the subject's
   * personal data sits in the payload table forever.
   */
  async expireStaleExports(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const raw = await manager.query(
        `SELECT id FROM privacy.data_requests
          WHERE kind = 'export' AND status = 'ready' AND expires_at <= now()
          FOR UPDATE SKIP LOCKED`,
      );
      const ids = (raw as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === 0) return 0;

      await manager.query('DELETE FROM privacy.export_payloads WHERE request_id = ANY($1::uuid[])', [ids]);
      await manager.query(
        `UPDATE privacy.data_requests SET status = 'expired', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      return ids.length;
    });
  }

  /**
   * Returns requests abandoned mid-flight to `pending` so the sweep retries
   * them.
   *
   * Without this a process that dies between the claim and the work leaves the
   * request in `processing` forever: no route serves it, no sweep re-reads it,
   * and nothing reports an error, because from the database's point of view
   * somebody is working on it right now.
   */
  async reclaimStalled(): Promise<number> {
    const raw = await this.requests.query(
      `UPDATE privacy.data_requests
          SET status = 'pending', updated_at = now()
        WHERE status = 'processing'
          AND updated_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
      [String(this.config.stalledProcessingMinutes)],
    );
    return returningRows<{ id: string }>(raw).length;
  }

  /**
   * Status compare-and-swap.
   *
   * `returningRows` because TypeORM hands back `[rows, rowCount]` for an
   * UPDATE, so a naive `raw.length === 0` is always false -- the exact bug
   * `sql-result.ts` exists to prevent, and one that here would let two sweeps
   * both "claim" the same erasure.
   */
  private async claim(
    requestId: string,
    from: string,
    to: string,
  ): Promise<{ id: string; subjectUserId: string } | null> {
    const raw = await this.requests.query(
      `UPDATE privacy.data_requests
          SET status = $3, updated_at = now()
        WHERE id = $1 AND status = $2
        RETURNING id, subject_user_id`,
      [requestId, from, to],
    );
    const rows = returningRows<{ id: string; subject_user_id: string }>(raw);
    if (rows.length === 0) return null;
    return { id: rows[0].id, subjectUserId: rows[0].subject_user_id };
  }

  // ------------------------------------------------------------ admin read

  /**
   * The operator's queue.
   *
   * Status and timing only. There is deliberately no route anywhere that lets
   * an operator read a payload, cancel somebody's erasure, or see what a
   * subject's data contains -- Phase E's security note states the first
   * without qualification, and the other two follow from the same principle.
   */
  async listForOperator(params: { page: number; limit: number; status?: string }): Promise<{
    items: Array<{
      id: string;
      subjectUserId: string;
      kind: DataRequestKind;
      status: string;
      requestedAt: Date;
      executeAfter: Date | null;
      expiresAt: Date | null;
      completedAt: Date | null;
      cancelledAt: Date | null;
      failureCode: string | null;
    }>;
    total: number;
  }> {
    const where = params.status ? { status: params.status as DataRequestEntity['status'] } : {};
    const [rows, total] = await this.requests.findAndCount({
      where,
      order: { requestedAt: 'DESC' },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    });

    return {
      items: rows.map((r) => ({
        id: r.id,
        subjectUserId: r.subjectUserId,
        kind: r.kind,
        status: r.status,
        requestedAt: r.requestedAt,
        executeAfter: r.executeAfter,
        expiresAt: r.expiresAt,
        completedAt: r.completedAt,
        cancelledAt: r.cancelledAt,
        failureCode: r.failureCode,
      })),
      total,
    };
  }
}

/** PostgreSQL's unique-violation SQLSTATE, via whichever driver shape TypeORM hands back. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}
