/**
 * 准备度字典的读写（设计 §2.1、§7 配置 CRUD 行；DEC-301①）。每个写入在命令台账的同一租户事务里完成“业务写 + 审计”
 * （DEC-019 / 216）。编码与名称租户唯一（唯一约束兜底，409 READINESS_DUPLICATE）；编码建后不可改（输入结构不收）。
 * 删除前对行 FOR UPDATE 再询问引用守卫（readiness-port.ts），被引用 409 READINESS_IN_USE；删除保留审计快照。
 */
import { and, asc, eq, pgErrorCode, talentReadinessLevels, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import {
  codeOf,
  type ModuleScope,
  notFoundMessage,
  requireConfigCreatable,
  requireConfigVisible,
  TALENT_REVIEW_AUDIT_ACTIONS,
  type TalentReviewContext,
} from './access.js';
import type { ReadinessCreate, ReadinessPatch } from './readiness-input.js';
import { readinessReferrer } from './readiness-port.js';

export interface WriteContext extends TalentReviewContext {
  readonly scope: ModuleScope;
}

const R = talentReadinessLevels;
const view = {
  id: R.id,
  code: R.code,
  name: R.name,
  description: R.description,
  color: R.color,
  sortNo: R.sortNo,
  enabled: R.enabled,
  revision: R.revision,
  createdBy: R.createdBy,
  createdAt: R.createdAt,
  updatedBy: R.updatedBy,
  updatedAt: R.updatedAt,
};
export type ReadinessView = NonNullable<Awaited<ReturnType<typeof loadReadinessView>>>;

export async function loadReadinessView(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx
    .select(view)
    .from(R)
    .where(and(eq(R.tenantId, tenantId), eq(R.id, id)));
  return row;
}

export function listReadinessViews(
  tx: Tx,
  tenantId: string,
  query: { limit: number; offset: number; enabled?: boolean; visible: SQL },
) {
  const filters = [eq(R.tenantId, tenantId), query.visible];
  if (query.enabled !== undefined) filters.push(eq(R.enabled, query.enabled));
  return tx
    .select(view)
    .from(R)
    .where(and(...filters))
    .orderBy(asc(R.sortNo), asc(R.code), asc(R.id))
    .limit(query.limit)
    .offset(query.offset);
}

/** 行锁 → 范围（范围外与不存在同一个 404）→ revision。 */
async function lockForWrite(tx: Tx, ctx: WriteContext, id: string) {
  const [row] = await tx
    .select({ revision: R.revision, createdBy: R.createdBy })
    .from(R)
    .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', notFoundMessage('readiness'));
  requireConfigVisible(ctx.scope, 'readiness', row.createdBy);
  if (row.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '准备度已变更，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: row.revision,
    });
  }
}

async function unique<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') {
      throw new AppError('CONFLICT', '准备度编码或名称重复', { reason: 'READINESS_DUPLICATE' });
    }
    throw error;
  }
}

async function audit(tx: Tx, ctx: WriteContext, operation: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${TALENT_REVIEW_AUDIT_ACTIONS.readiness}.${operation}`,
    objectType: codeOf('readiness'),
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

export async function createReadiness(tx: Tx, ctx: WriteContext, input: ReadinessCreate) {
  requireConfigCreatable(ctx.scope, 'readiness');
  const [row] = await unique(() =>
    tx
      .insert(R)
      .values({
        tenantId: ctx.tenantId,
        ...input,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning({ id: R.id }),
  );
  const after = (await loadReadinessView(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'create', after.id, null, after);
  return after;
}

export async function updateReadiness(tx: Tx, ctx: WriteContext, id: string, patch: ReadinessPatch) {
  await lockForWrite(tx, ctx, id);
  const before = (await loadReadinessView(tx, ctx.tenantId, id))!;
  // 名称租户唯一：只有创建人范围的人改名时，撞上他人隐藏记录的 409 与成功之间的差异会暴露该记录存在（第 2 轮 P2-01）。
  // 所以改名要求看全部（与新建同口径，DEC-082 / 121），在任何查重之前判定，目标名称是否被占用都同一个 403。
  if (patch.name !== undefined && patch.name !== before.name && !ctx.scope.all) {
    throw new AppError('FORBIDDEN', '只有能查看全部准备度的人可以修改名称', {
      reason: 'READINESS_NAME_REQUIRES_SEE_ALL',
    });
  }
  await unique(() =>
    tx
      .update(R)
      .set({ ...patch, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id))),
  );
  const after = (await loadReadinessView(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'update', id, before, after);
  return after;
}

export async function deleteReadiness(tx: Tx, ctx: WriteContext, id: string) {
  await lockForWrite(tx, ctx, id);
  const referrer = await readinessReferrer(tx, ctx.tenantId, id);
  if (referrer)
    throw new AppError('CONFLICT', '准备度已被引用，不能删除，可以停用', { reason: 'READINESS_IN_USE', referrer });
  const before = (await loadReadinessView(tx, ctx.tenantId, id))!;
  await tx.delete(R).where(and(eq(R.tenantId, ctx.tenantId), eq(R.id, id)));
  await audit(tx, ctx, 'delete', id, before, null);
  return before;
}
