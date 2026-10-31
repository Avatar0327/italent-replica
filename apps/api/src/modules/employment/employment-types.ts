/**
 * F-323（DEC-706）：人员类别租户字典；任职 / 兼职按 ID 引用，名称读当前字典。
 * 删除为软删（保留 presetKey，种子补装不复活），被任职 / 兼职引用的不可删；F-323c 退休条件按 ID 复用启用校验。
 */
import { and, asc, employmentTypes as table, eq, sql, type Tx } from '@italent/db';
import {
  EMPLOYMENT_TYPE_PRESETS,
  EMPLOYMENT_TYPE_VIEWS,
  MODULE_OBJECTS,
  type EmploymentTypeView,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { registerSeed, type SeedWriteContext } from '../../seeds/registry.js';
import { auditActor } from '../../system-actor.js';
import { validIsoDate } from '../org/read-model.js';
import { assertRevision } from './context.js';
import { rowsOf } from './read-model.js';
import type { EmploymentContext } from './types.js';

export const EMPLOYMENT_TYPE_OBJECT = MODULE_OBJECTS.employmentType.code;
const LIMIT = 500;
const columns = {
  id: table.id,
  name: table.name,
  displayOrder: table.displayOrder,
  effectiveDate: table.effectiveDate,
  expiryDate: table.expiryDate,
  enabled: table.enabled,
  revision: table.revision,
};
export type EmploymentTypeItem = Awaited<ReturnType<typeof listEmploymentTypes>>[number];
const date = z.string().refine(validIsoDate, '日期必须为合法 YYYY-MM-DD');
const inputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  displayOrder: z.int().min(0).max(100000),
  effectiveDate: date,
  expiryDate: date.optional(),
});
export type EmploymentTypeInput = z.infer<typeof inputSchema>;

export function parseEmploymentType(raw: unknown, update = false): Partial<EmploymentTypeInput> {
  const parsed = (update ? inputSchema.partial() : inputSchema).safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '人员类别字段不合法', parsed.error.issues);
  return parsed.data;
}

export function parseEmploymentTypeView(raw: string | undefined): EmploymentTypeView {
  const view = raw ?? 'enabled';
  if (!(EMPLOYMENT_TYPE_VIEWS as readonly string[]).includes(view))
    throw new AppError('VALIDATION_FAILED', '人员类别视图不合法', { field: 'view' });
  return view as EmploymentTypeView;
}

const live = (tenantId: string) => and(eq(table.tenantId, tenantId), sql`${table.deletedAt} IS NULL`);

export async function listEmploymentTypes(tx: Tx, tenantId: string, view: EmploymentTypeView = 'all') {
  const enabled = view === 'all' ? undefined : eq(table.enabled, view === 'enabled');
  return tx
    .select(columns)
    .from(table)
    .where(and(live(tenantId), enabled))
    .orderBy(asc(table.displayOrder), asc(table.createdAt), asc(table.id))
    .limit(LIMIT);
}

/** 按 ID 读一条（未删除）；供 F-323c 退休条件等调用方取名称。 */
export async function findEmploymentType(tx: Tx, tenantId: string, id: string) {
  const [row] = await tx
    .select(columns)
    .from(table)
    .where(and(live(tenantId), eq(table.id, id)));
  return row;
}

/** 名称（含已停用 / 已删除）；供人员履历快照等只需显示名称的调用方。 */
export async function employmentTypeName(tx: Tx, tenantId: string, id: unknown): Promise<string | null> {
  if (typeof id !== 'string') return null;
  const [row] = await tx
    .select({ name: table.name })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
  return row?.name ?? null;
}

/**
 * 校验入口：在调用方 withTenant 事务中校验至多 500 个 ID；不存在 / 已删除 / 跨租户 / 停用均 422。
 * 按文本比较：审批编辑等入口不经 UUID 解析，旧名称文本须落成“未知”而不是 uuid 转换的数据库错误。
 */
export async function requireEnabledEmploymentTypes(tx: Tx, tenantId: string, ids: readonly string[]) {
  await requireEmploymentTypes(tx, tenantId, ids, true);
}

async function requireEmploymentTypes(tx: Tx, tenantId: string, ids: readonly string[], enabledOnly: boolean) {
  if (!ids.length) return;
  if (ids.length > LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '人员类别校验超过上限');
  const found = await tx
    .select({ id: table.id, enabled: table.enabled })
    .from(table)
    .where(and(live(tenantId), sql`${table.id}::text IN ${ids}`))
    .for('share');
  const byId = new Map(found.map((row) => [row.id, row.enabled]));
  for (const id of ids) {
    if (byId.get(id) === true || (!enabledOnly && byId.has(id))) continue;
    throw new AppError('EMPLOYMENT_TYPE_INVALID', '人员类别不存在或已停用', {
      field: 'employmentType',
      reason: byId.get(id) === false ? 'EMPLOYMENT_TYPE_DISABLED' : 'EMPLOYMENT_TYPE_UNKNOWN',
    });
  }
}

function typeId(id: unknown): id is string {
  if (id === null || id === undefined) return false;
  if (typeof id !== 'string') throw new AppError('EMPLOYMENT_TYPE_INVALID', '人员类别必须是字典 ID');
  return true;
}

/**
 * 存量引用校验（任职 / 兼职每次追加版本，同用工形式 F-321 的写入口）：本租户未删除的字典 ID 即可，停用不拦；
 * null / 未给表示不选。离职、结束兼职、调动、重排期等沿用原值的继承路径保留已停用的原引用（F-323 第 1 轮审查 P2-1）。
 */
export async function validateEmploymentType(tx: Tx, tenantId: string, id: unknown) {
  if (typeId(id)) await requireEmploymentTypes(tx, tenantId, [id], false);
}

/** 显式选择（入职 / 业务表单、编辑任职、兼职新增与编辑）：与沿用值（前驱 / 原记录）不同即新选 / 改选，须启用。 */
export async function validateSelectedEmploymentType(tx: Tx, tenantId: string, id: unknown, inherited?: unknown) {
  if (typeId(id)) await requireEmploymentTypes(tx, tenantId, [id], id !== inherited);
}

/** 名称补充发生在字段权限裁剪后（看不到 employmentType 就不补名称）；停用 / 删除后仍显示历史名称。 */
export async function employmentTypeNames(tx: Tx, tenantId: string, value: unknown): Promise<unknown> {
  const ids = new Set<string>();
  function visit(node: unknown, names?: ReadonlyMap<string, string>): unknown {
    if (Array.isArray(node)) return node.map((child) => visit(child, names));
    if (!node || typeof node !== 'object' || node instanceof Date) return node;
    const object = node as Record<string, unknown>;
    const result = Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child, names)]));
    if (typeof object.employmentType === 'string') {
      ids.add(object.employmentType);
      if (names) result.employmentTypeName = names.get(object.employmentType) ?? null;
    }
    return result;
  }
  visit(value);
  if (!ids.size) return value;
  const found = await tx
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), sql`${table.id}::text IN ${[...ids]}`));
  return visit(value, new Map(found.map((row) => [row.id, row.name])));
}

const lock = (tx: Tx, tenantId: string) => advisoryLock(tx, asUuid(tenantId), ':employment-types');
async function audit(
  tx: Tx,
  writer: SeedWriteContext,
  id: string,
  before: object | null,
  after: object | null,
  action = 'employment_type.save',
) {
  await recordAudit(tx, {
    tenantId: writer.tenantId,
    actorUserId: writer.actorUserId,
    action,
    objectType: 'employment_type',
    objectId: id,
    before,
    after,
    commandId: writer.commandId,
    occurredAt: writer.now,
  });
}
const writerOf = (ctx: EmploymentContext): SeedWriteContext => ({
  tenantId: ctx.tenantId,
  actorUserId: auditActor(ctx.userId),
  commandId: ctx.commandId,
  now: ctx.now,
});

async function current(tx: Tx, ctx: EmploymentContext, id: string) {
  const [before] = await tx
    .select(columns)
    .from(table)
    .where(and(live(ctx.tenantId), eq(table.id, id)))
    .for('update');
  if (!before) throw new AppError('NOT_FOUND', '人员类别不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

async function write(tx: Tx, ctx: EmploymentContext, before: EmploymentTypeItem, changes: object) {
  const [after] = await tx
    .update(table)
    .set({ ...changes, revision: before.revision + 1, updatedAt: ctx.now })
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, before.id)))
    .returning(columns);
  await audit(tx, writerOf(ctx), before.id, before, after!);
  return after!;
}

export async function saveEmploymentType(
  tx: Tx,
  ctx: EmploymentContext,
  input: Partial<EmploymentTypeInput>,
  id?: string,
) {
  await lock(tx, ctx.tenantId);
  const before = id ? await current(tx, ctx, id) : undefined;
  if (!before) assertRevision(ctx.expectedRevision, 0);
  const next = { expiryDate: '9999-12-31', ...before, ...input } as EmploymentTypeInput & { expiryDate: string };
  if (next.effectiveDate > next.expiryDate) throw new AppError('VALIDATION_FAILED', '失效日期不得早于生效日期');
  if (before) return write(tx, ctx, before, input);
  const [existing] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(live(ctx.tenantId));
  if ((existing?.count ?? 0) >= LIMIT) throw new AppError('CONFLICT', '人员类别已达上限');
  const [after] = await tx
    .insert(table)
    .values({ ...next, tenantId: ctx.tenantId, createdAt: ctx.now, updatedAt: ctx.now })
    .returning(columns);
  await audit(tx, writerOf(ctx), after!.id, null, after!);
  return after!;
}

/** 详情“停用”（原站）与“启用”（🟡 未取证，对称补齐）：状态不变时 409，不静默成功。 */
export async function setEmploymentTypeEnabled(tx: Tx, ctx: EmploymentContext, id: string, enabled: boolean) {
  await lock(tx, ctx.tenantId);
  const before = await current(tx, ctx, id);
  if (before.enabled === enabled)
    throw new AppError('CONFLICT', enabled ? '人员类别已启用' : '人员类别已停用', {
      reason: enabled ? 'EMPLOYMENT_TYPE_ALREADY_ENABLED' : 'EMPLOYMENT_TYPE_ALREADY_DISABLED',
    });
  return write(tx, ctx, before, { enabled });
}

/** 删除：任一任职载荷 / 记录 / 兼职申请版本引用即 409；软删并留快照审计。 */
export async function deleteEmploymentType(tx: Tx, ctx: EmploymentContext, id: string) {
  await lock(tx, ctx.tenantId);
  const before = await current(tx, ctx, id);
  const used = await tx.execute(sql`SELECT 1 FROM (
      SELECT 1 FROM employment_payload_versions WHERE tenant_id=${ctx.tenantId} AND employment_type=${id}::uuid
      UNION ALL SELECT 1 FROM employment_records WHERE tenant_id=${ctx.tenantId} AND employment_type=${id}::uuid
      UNION ALL SELECT 1 FROM part_time_request_versions WHERE tenant_id=${ctx.tenantId} AND employment_type=${id}::uuid
    ) used LIMIT 1`);
  if (rowsOf(used).length)
    throw new AppError('CONFLICT', '人员类别已被任职记录引用，不能删除', { reason: 'EMPLOYMENT_TYPE_IN_USE' });
  await tx
    .update(table)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now, revision: before.revision + 1 })
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, id)));
  await audit(tx, writerOf(ctx), id, before, null, 'employment_type.delete');
  return { id, deleted: true };
}

registerSeed({
  module: 'employment-types',
  key: 'employment-types',
  version: 1,
  codes: EMPLOYMENT_TYPE_PRESETS.map((item) => item.presetKey),
  // 含已软删的预置：删掉的不再补装
  existing: async (tx, tenantId) =>
    new Set(
      (
        await tx
          .select({ presetKey: table.presetKey })
          .from(table)
          .where(and(eq(table.tenantId, tenantId), sql`${table.presetKey} IS NOT NULL`))
      ).map((row) => row.presetKey!),
    ),
  install: async (tx, writer, missing) => {
    await lock(tx, writer.tenantId);
    for (const preset of EMPLOYMENT_TYPE_PRESETS) {
      if (!missing.includes(preset.presetKey)) continue;
      const [after] = await tx
        .insert(table)
        .values({ ...preset, tenantId: writer.tenantId, createdAt: writer.now, updatedAt: writer.now })
        .onConflictDoNothing()
        .returning(columns);
      if (after) await audit(tx, writer, after.id, null, after);
    }
    return { skipped: [] };
  },
});
