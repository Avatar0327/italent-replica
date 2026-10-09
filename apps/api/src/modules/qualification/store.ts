/**
 * 任职资格写入的公共部分（设计 §3.1、§5.1、§8）：每个写入在命令台账的同一租户事务里完成“业务写 + 审计”
 * （DEC-019 / 216），审计行带所属组织作归属（审计查询按查看人当前范围裁剪，不因向下公开放宽）。
 * 取锁顺序：标准 → 指标 → 类别 / 级别 / 指标类型 / 等级方案（被引用方 FOR SHARE，停用 / 删除先 FOR UPDATE）；
 * 通用指标覆盖写入先按 id 升序锁标准、再锁指标（§3.1 / §3.4），与冻结、标准编辑的锁序一致。
 */
import { pgErrorCode, sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { QUALIFICATION_APP, QUALIFICATION_AUDIT_ACTIONS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { chooseUnit } from '../permission/owner-units.js';
import { visible } from '../permission/module-route-access.js';
import {
  type Access,
  ANCHOR,
  accessSql,
  codeOf,
  type ModuleScope,
  QUALIFICATION_LABELS,
  type QualificationContext,
  type QualificationObject,
  requireEditable,
  requireReadable,
  rowsOf,
} from './access.js';

/** 写命令的上下文：请求上下文 + 查看人当前的范围（按对象，事务外解析）+ 若干可见字段。 */
export interface WriteContext extends QualificationContext {
  readonly scope: ModuleScope;
  readonly scopes: Readonly<Partial<Record<QualificationObject, ModuleScope | null>>>;
  readonly fields: Readonly<Partial<Record<QualificationObject, ReadonlySet<string> | undefined>>>;
  /** 删除父对象时连带删除的子对象：操作人当前对该子对象有无删除数据操作权（在路由层按当前授权解析）。 */
  readonly childDeletes?: Readonly<Partial<Record<QualificationObject, boolean>>>;
}

export const TABLES: Readonly<Partial<Record<QualificationObject, string>>> = {
  categoryClass: 'ql_category_classes',
  category: 'ql_categories',
  layer: 'ql_layers',
  level: 'ql_levels',
  targetType: 'ql_target_types',
  target: 'ql_targets',
  gradeScheme: 'ql_grade_schemes',
  codingRule: 'ql_coding_rules',
  standard: 'ql_standards',
};

export function tableOf(object: QualificationObject): string {
  const table = TABLES[object];
  if (!table) throw new Error(`没有登记${QUALIFICATION_LABELS[object]}的表`);
  return table;
}

interface AccessRow {
  readonly revision: number;
  readonly editable: boolean;
  readonly readable: boolean;
  readonly [column: string]: unknown;
}

const accessOf = (row: AccessRow | undefined): Access =>
  !row ? 'none' : row.editable === true ? 'edit' : row.readable === true ? 'view' : 'none';

/** 读一行并按 `scope` 判定可写 / 可读；`lock` 为行锁模式。 */
export async function rowAccess(
  tx: Tx,
  ctx: QualificationContext,
  scope: ModuleScope,
  object: QualificationObject,
  id: string,
  lock?: 'UPDATE' | 'SHARE',
): Promise<{ access: Access; row: AccessRow | undefined }> {
  const { editable, readable } = accessSql(ctx, scope, ANCHOR[object]);
  const result = await tx.execute(sql`SELECT t.*, (${editable}) AS editable, (${readable}) AS readable
    FROM ${sql.identifier(tableOf(object))} t WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.id = ${id}::uuid
    ${lock ? sql.raw(`FOR ${lock} OF t`) : sql``}`);
  const row = rowsOf<AccessRow>(result)[0];
  return { access: accessOf(row), row };
}

/** 写入的定位：行锁 → 可写（不可见 404、仅向下公开 403）→ revision。 */
export async function lockEditable(tx: Tx, ctx: WriteContext, object: QualificationObject, id: string) {
  const { access, row } = await rowAccess(tx, ctx, ctx.scope, object, id, 'UPDATE');
  requireEditable(access, object);
  if (row!.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', `${QUALIFICATION_LABELS[object]}已变更，请刷新后显式重提`, {
      expected: ctx.expectedRevision,
      actual: row!.revision,
    });
  }
  return row!;
}

/**
 * 被引用的同应用对象（上级分类、所属分类、层级、指标类型、等级方案、类别、级别、指标）：查看权（403）→ FOR SHARE →
 * 在读取范围内（向下公开可引用）→ 启用（只拦新引用，`requireEnabled` 由调用方按“是否新引用”决定）。
 */
export async function referenced(
  tx: Tx,
  ctx: WriteContext,
  object: QualificationObject,
  id: string,
  requireEnabled = true,
): Promise<AccessRow> {
  const scope = ctx.scopes[object];
  const label = QUALIFICATION_LABELS[object];
  if (scope === null) throw new AppError('FORBIDDEN', `无权查看${label}`);
  if (!scope) throw new Error(`未解析${label}的引用范围`);
  const { access, row } = await rowAccess(tx, ctx, scope, object, id, 'SHARE');
  requireReadable(access, object);
  if (requireEnabled && row!.enabled === false) {
    throw new AppError('VALIDATION_FAILED', `${label}已停用，不能引用`, { reason: 'REFERENCE_DISABLED', id });
  }
  return row!;
}

/**
 * 新建带资源集合的对象：资源集合 = 创建人在 Qualification 应用的授权管理单元（DEC-324②，同 DEC-294③），
 * 再按新建授权复核（DEC-082：只看管理范围）。DEC-339（同 #106）：没有单元 403；只有一个自动填写；多个时必须由请求
 * 显式选一个，不选 400 MANAGEMENT_UNIT_REQUIRED，不自动挑；选了不属于本人的单元与不存在同一个 404。
 */
export async function ownerOf(tx: Tx, ctx: WriteContext, object: QualificationObject, requested: string | undefined) {
  const orgId = await chooseUnit(tx, ctx, QUALIFICATION_APP, requested);
  visible(ctx.scope, orgId, `${QUALIFICATION_LABELS[object]}不存在`);
  return { ownerId: ctx.userId, ownerOrgId: orgId };
}

/** 对象编码的格式（与库里的编码 CHECK 一致）；编码规则的前缀须能拼出合法编码（第 2 轮 P2-08）。 */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/;

/**
 * 编码规则自动编码（QL-R3）：编码留空且规则启用时取“前缀 + 序号”并递增；规则未启用时编码必填。
 * 推进序号同时 revision + 1：编码规则的编辑按 revision 判断旧状态，拿旧 revision 的保存不能把序号退回（P2-06）。
 * 拼出的编码不合法（库里遗留的不可用前缀）时给出明确的 400，不让编码约束变成 500（P2-08）。
 */
export async function autoCode(
  tx: Tx,
  ctx: WriteContext,
  item: 'category' | 'level' | 'target_type' | 'target',
  code: string | undefined,
): Promise<string> {
  if (code) return code;
  await tx.execute(sql`INSERT INTO ql_coding_rules (tenant_id, item, created_by)
    VALUES (${ctx.tenantId}, ${item}, ${ctx.userId}) ON CONFLICT (tenant_id, item) DO NOTHING`);
  const rule = rowsOf<{ enabled: boolean; prefix: string; next_seq: number }>(
    await tx.execute(sql`SELECT enabled, prefix, next_seq FROM ql_coding_rules
      WHERE tenant_id = ${ctx.tenantId} AND item = ${item} FOR UPDATE`),
  )[0]!;
  if (!rule.enabled) throw new AppError('VALIDATION_FAILED', '请填写编码', { reason: 'CODE_REQUIRED' });
  const generated = `${rule.prefix}${rule.next_seq}`;
  if (!CODE_PATTERN.test(generated)) {
    throw new AppError('VALIDATION_FAILED', '编码规则生成的编码不合法，请检查编码规则的前缀或手工填写编码', {
      reason: 'CODE_INVALID',
    });
  }
  await tx.execute(sql`UPDATE ql_coding_rules SET next_seq = next_seq + 1, revision = revision + 1,
    updated_at = ${ctx.now.toISOString()} WHERE tenant_id = ${ctx.tenantId} AND item = ${item}`);
  return generated;
}

/** 编码在租户内唯一（同表）；先查给出明确的 409，唯一约束兜底并发。 */
export async function requireCodeAvailable(
  tx: Tx,
  ctx: QualificationContext,
  object: QualificationObject,
  code: string,
  exceptId?: string,
) {
  const result = await tx.execute(sql`SELECT 1 FROM ${sql.identifier(tableOf(object))}
    WHERE tenant_id = ${ctx.tenantId} AND code = ${code}
      AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)
    LIMIT 1`);
  if (rowsOf(result).length) throw duplicate('编码');
}

export const duplicate = (what: string) => new AppError('CONFLICT', `${what}重复，请重新输入`, { reason: 'DUPLICATE' });

/** 唯一约束冲突（并发兜底）转成 409；`conflict` 给出该约束对应的明确错误（缺省“编码重复”）。 */
export async function guardUnique<T>(work: () => Promise<T>, conflict: string | (() => AppError) = '编码'): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (pgErrorCode(error) === '23505') throw typeof conflict === 'string' ? duplicate(conflict) : conflict();
    throw error;
  }
}

/** 删除前的“还在使用”：有引用即 409，数据不变。 */
export async function rejectInUse(tx: Tx, usage: { sql: SQL; message: string; reason: string }) {
  const result = await tx.execute(sql`SELECT EXISTS (${usage.sql}) AS used`);
  if (rowsOf<{ used: boolean }>(result)[0]?.used) {
    throw new AppError('CONFLICT', usage.message, { reason: usage.reason });
  }
}

/**
 * 删除父对象会连带删除子对象时（数据库外键 CASCADE），子对象另需删除权，并各写一条删除审计留快照
 * （DEC-019；开发自检 DEC-338 服务端规则）。没有这类子对象时不要求子对象的删除权。
 */
export async function deleteChildren(
  tx: Tx,
  ctx: WriteContext,
  child: QualificationObject,
  rows: readonly { readonly objectId: string; readonly orgId: string | null; readonly snapshot: unknown }[],
) {
  if (!rows.length) return;
  if (!ctx.childDeletes?.[child]) {
    throw new AppError('FORBIDDEN', `无权删除${QUALIFICATION_LABELS[child]}`, { reason: 'CHILD_DELETE_FORBIDDEN' });
  }
  // 一行一条：快照的键就是子对象的字段（对得上字段目录，审计员才查得到，第 2 轮 P2-11）
  for (const row of rows) {
    await audit(tx, ctx, child, 'delete', row.objectId, { before: row.snapshot, after: null, orgId: row.orgId });
  }
}

export async function audit(
  tx: Tx,
  ctx: QualificationContext,
  object: QualificationObject,
  operation: string,
  id: string,
  change: { before: unknown; after: unknown; orgId?: string | null },
) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${QUALIFICATION_AUDIT_ACTIONS[object]}.${operation}`,
    objectType: codeOf(object),
    objectId: id,
    before: change.before,
    after: change.after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
    // DEC-197 归属：审计查询按查看人当前范围裁剪（设计 §8），删除后仍可判断
    ...(change.orgId ? { scope: { orgId: change.orgId } } : {}),
  });
}

/** 原生 SQL 参数：时间一律传 ISO 字符串（postgres-js 不接受 Date 参数，PGlite 接受，见 idp 同法）。 */
export const bumped = (ctx: QualificationContext) => ({
  revision: ctx.expectedRevision + 1,
  updatedAt: ctx.now.toISOString(),
});

export { rowsOf };
