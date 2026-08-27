import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { uuidv7 } from 'uuidv7';
import { currentCorrelationId } from '@beauclick/events';
import { AdminAuditLogEntity, AuditSnapshot } from './admin-audit-log.entity';

export interface AdminAuditInput {
  /** The authenticated session's user id. Never accepted from a request body. */
  actorUserId: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
  reason?: string | null;
}

export interface AdminAuditQuery {
  page: number;
  limit: number;
  action?: string;
  targetType?: string;
  targetId?: string;
  actorUserId?: string;
}

/**
 * The persistent administrative audit trail.
 *
 * HOW THIS DIFFERS FROM `AuditLogger` (`@beauclick/events`), because two things
 * called "audit" in one codebase needs the distinction stated rather than
 * inferred:
 *
 *   `AuditLogger`  — domain-level operational logging, 15 call sites across
 *                    every service, written to the structured application
 *                    logger. Best-effort by design and useful for tracing.
 *                    It is not a record anyone can query as part of the
 *                    product, and a mutation whose log line is lost succeeds
 *                    anyway. It stays exactly as it is.
 *
 *   `AdminAuditService` — the permanent, append-only, DB-enforced record of
 *                    PRIVILEGED actions. Mandatory: a mutation that requires
 *                    an audit record must not commit without one.
 *
 * That last property is the whole point, and it is why `record()` takes an
 * `EntityManager`. Writing the audit row inside the caller's own transaction
 * means the mutation and its record commit together or not at all. A
 * best-effort side-effect written after the commit is precisely the shape that
 * lets an unaudited administrative action exist -- and V2 found that bug class
 * three separate times across two plugins.
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AdminAuditLogEntity)
    private readonly repo: Repository<AdminAuditLogEntity>,
  ) {}

  /**
   * Appends one audit row **inside the caller's transaction**.
   *
   * If the insert fails, the caller's transaction fails with it. That is the
   * intended behaviour and not a hazard to route around: an administrative
   * mutation that cannot be recorded must not happen.
   */
  async record(manager: EntityManager, input: AdminAuditInput): Promise<void> {
    await manager.getRepository(AdminAuditLogEntity).insert({
      id: uuidv7(),
      actorUserId: input.actorUserId,
      actorLabel: null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      beforeState: input.before ?? null,
      afterState: input.after ?? null,
      reason: input.reason ?? null,
      // Attached by construction rather than by every author remembering:
      // an audit trail that carries the correlation id on most rows is not
      // one you can follow.
      correlationId: currentCorrelationId() ?? null,
    });
  }

  /**
   * Records an action that CANNOT share the caller's transaction, in its own.
   *
   * Only for routes that have declared `@AuditAction(..., { transactional:
   * false, because })` -- a settlement (a physically separate DataSource,
   * ADR-017) or a search reindex (an external system). Using this where a
   * shared transaction is available would silently give up the guarantee
   * GAP-02-V3 exists to establish, which is why the declaration is required at
   * the route and states the physical reason.
   *
   * The row follows the action. A crash in between leaves an action with no
   * record; that is disclosed rather than designed around, because the
   * alternative -- writing the row first -- would leave a record of an action
   * that never happened, which is worse.
   */
  async recordDetached(input: AdminAuditInput): Promise<void> {
    await this.dataSource.transaction((manager) => this.record(manager, input));
  }

  /**
   * For actions with no session actor. The ONLY intended caller is the
   * documented one-time bootstrap, which has no privileged account to act as
   * yet -- and which must still leave a trace.
   */
  async recordSystem(
    manager: EntityManager,
    input: Omit<AdminAuditInput, 'actorUserId'> & { actorLabel: string },
  ): Promise<void> {
    await manager.getRepository(AdminAuditLogEntity).insert({
      id: uuidv7(),
      actorUserId: null,
      actorLabel: input.actorLabel,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      beforeState: input.before ?? null,
      afterState: input.after ?? null,
      reason: input.reason ?? null,
      correlationId: currentCorrelationId() ?? null,
    });
  }

  /** Read-only, newest first. There is no update or delete counterpart, by design. */
  async list(query: AdminAuditQuery): Promise<{ items: AdminAuditLogEntity[]; total: number }> {
    const qb = this.repo.createQueryBuilder('a').orderBy('a.created_at', 'DESC');

    if (query.action) qb.andWhere('a.action = :action', { action: query.action });
    if (query.targetType) qb.andWhere('a.target_type = :targetType', { targetType: query.targetType });
    if (query.targetId) qb.andWhere('a.target_id = :targetId', { targetId: query.targetId });
    if (query.actorUserId) qb.andWhere('a.actor_user_id = :actorUserId', { actorUserId: query.actorUserId });

    const [items, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    return { items, total };
  }

  /** The distinct action names present, so the filter offers real values rather than a free-text box. */
  async knownActions(): Promise<string[]> {
    const rows: { action: string }[] = await this.repo
      .createQueryBuilder('a')
      .select('DISTINCT a.action', 'action')
      .orderBy('a.action', 'ASC')
      .getRawMany();
    return rows.map((r) => r.action);
  }
}
