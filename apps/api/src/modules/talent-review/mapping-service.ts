/**
 * 字段映射的读写（设计 §2.2 field_mappings、TR-R9）。来源 / 目标字段的跨对象规则：
 * - 引用字段 = 读取字段对象：不存在与范围外同一个 404（范围由路由按字段对象解析后传入），先共享锁住两个字段行
 *   （与字段删除的 FOR UPDATE 串行：删除先到则 404，映射先提交则删除被引用守卫拒绝 409 FIELD_IN_USE）；
 * - 已启用（停用后不可新引用，设计 §7 启停行）；类型相同，单选 / 多选的选项值集合相同（领域函数 mappingCompatibility）；
 * - 场景建后不可改；预置映射（“标签 → 标签”，DEC-361 登记）不可改不可删；同一场景同一对来源 / 目标不能重复。
 * 之后字段选项变化可能使映射失效，PR-C 带入时用同一个 mappingCompatibility 复核。
 */
import {
  and,
  asc,
  eq,
  inArray,
  pgErrorCode,
  talentReviewFieldMappings as M,
  talentReviewFieldOptions as O,
  talentReviewFields as F,
  type Tx,
} from '@italent/db';
import { mappingCompatibility } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { notFoundMessage, requireConfigCreatable, requireConfigVisible, type ModuleScope } from './access.js';
import type { MappingCreate, MappingPatch } from './config-input.js';
import {
  auditConfig,
  type ConfigSpec,
  type ConfigTable,
  lockConfigRow,
  registerConfigReferenceGuard,
  type WriteContext,
} from './config-kit.js';

const row = {
  id: M.id,
  scene: M.scene,
  sourceFieldId: M.sourceFieldId,
  targetFieldId: M.targetFieldId,
  preset: M.preset,
  revision: M.revision,
  createdBy: M.createdBy,
  createdAt: M.createdAt,
  updatedBy: M.updatedBy,
  updatedAt: M.updatedAt,
};
export type MappingView = Omit<typeof M.$inferSelect, 'tenantId'>;

export const MAPPING: ConfigSpec<MappingView> = {
  object: 'mapping',
  label: '字段映射',
  table: M as unknown as ConfigTable,
  view: row,
  orderBy: [],
  duplicate: 'MAPPING_DUPLICATE',
  inUse: 'MAPPING_IN_USE',
  load: async (tx, tenantId, id) => {
    const [found] = await tx
      .select(row)
      .from(M)
      .where(and(eq(M.tenantId, tenantId), eq(M.id, id)));
    return found;
  },
};

// 被映射引用的字段不可删（字段删除时同事务询问；RESTRICT 外键兜底）
registerConfigReferenceGuard('field', async (tx, tenantId, fieldId) => {
  const [used] = await tx
    .select({ id: M.id })
    .from(M)
    .where(and(eq(M.tenantId, tenantId), eq(M.sourceFieldId, fieldId)))
    .limit(1);
  if (used) return 'FIELD_MAPPING';
  const [target] = await tx
    .select({ id: M.id })
    .from(M)
    .where(and(eq(M.tenantId, tenantId), eq(M.targetFieldId, fieldId)))
    .limit(1);
  return target ? 'FIELD_MAPPING' : null;
});

export async function listMappings(
  tx: Tx,
  tenantId: string,
  query: { limit: number; offset: number; scene?: string; visible: SQL },
) {
  const filters = [eq(M.tenantId, tenantId), query.visible];
  if (query.scene !== undefined) filters.push(eq(M.scene, query.scene));
  return tx
    .select(row)
    .from(M)
    .where(and(...filters))
    .orderBy(asc(M.scene), asc(M.createdAt), asc(M.id))
    .limit(query.limit)
    .offset(query.offset);
}

const invalid = (reason: string, message: string) => new AppError('VALIDATION_FAILED', message, { reason });

/** 共享锁住来源 / 目标字段（按 id 升序，避免与别处交叉），返回两端的形状与启用状态。 */
async function lockFields(tx: Tx, ctx: WriteContext, fieldScope: ModuleScope, ids: readonly string[]) {
  const unique = [...new Set(ids)].sort();
  const rows = await tx
    .select({ id: F.id, kind: F.kind, enabled: F.enabled, createdBy: F.createdBy })
    .from(F)
    .where(and(eq(F.tenantId, ctx.tenantId), inArray(F.id, unique)))
    .orderBy(asc(F.id))
    .for('share');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const options = await tx
    .select({ fieldId: O.fieldId, value: O.value })
    .from(O)
    .where(and(eq(O.tenantId, ctx.tenantId), inArray(O.fieldId, unique)));
  return (id: string) => {
    const found = byId.get(id);
    // 不存在与字段范围外同一个 404，不暴露字段是否存在
    if (!found) throw new AppError('NOT_FOUND', notFoundMessage('field'));
    requireConfigVisible(fieldScope, 'field', found.createdBy);
    return {
      enabled: found.enabled,
      shape: { kind: found.kind, optionValues: options.filter((o) => o.fieldId === id).map((o) => o.value) },
    };
  };
}

async function validatePair(
  tx: Tx,
  ctx: WriteContext,
  fieldScope: ModuleScope,
  pair: { sourceFieldId: string; targetFieldId: string },
) {
  const resolve = await lockFields(tx, ctx, fieldScope, [pair.sourceFieldId, pair.targetFieldId]);
  const source = resolve(pair.sourceFieldId);
  const target = resolve(pair.targetFieldId);
  if (!source.enabled || !target.enabled) throw invalid('MAPPING_FIELD_DISABLED', '映射不能引用已停用的字段');
  const problem = mappingCompatibility(source.shape, target.shape);
  if (problem) throw invalid(problem, '映射的来源与目标字段类型或选项不一致');
}

async function duplicateOr<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (pgErrorCode(error) === '23505') {
      throw new AppError('CONFLICT', '该场景下已有相同的字段映射', { reason: MAPPING.duplicate });
    }
    throw error;
  }
}

export async function createMapping(
  tx: Tx,
  ctx: WriteContext,
  fieldScope: ModuleScope,
  input: MappingCreate,
): Promise<MappingView> {
  requireConfigCreatable(ctx.scope, 'mapping');
  await validatePair(tx, ctx, fieldScope, input);
  const [created] = await duplicateOr(() =>
    tx
      .insert(M)
      .values({
        tenantId: ctx.tenantId,
        ...input,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning({ id: M.id }),
  );
  const after = (await MAPPING.load!(tx, ctx.tenantId, created!.id))!;
  await auditConfig(tx, ctx, 'mapping', 'create', after.id, null, after);
  return after;
}

export async function updateMapping(
  tx: Tx,
  ctx: WriteContext,
  fieldScope: ModuleScope | undefined,
  id: string,
  patch: MappingPatch,
): Promise<MappingView> {
  await lockConfigRow(tx, MAPPING, ctx, id);
  const before = (await MAPPING.load!(tx, ctx.tenantId, id))!;
  if (before.preset) throw new AppError('CONFLICT', '预置映射不能修改', { reason: 'MAPPING_PRESET' });
  const next = {
    sourceFieldId: patch.sourceFieldId ?? before.sourceFieldId,
    targetFieldId: patch.targetFieldId ?? before.targetFieldId,
  };
  // 没有改动来源 / 目标时不读取字段（也就不需要字段对象的范围）
  if (fieldScope) await validatePair(tx, ctx, fieldScope, next);
  await duplicateOr(() =>
    tx
      .update(M)
      .set({ ...next, revision: ctx.expectedRevision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
      .where(and(eq(M.tenantId, ctx.tenantId), eq(M.id, id))),
  );
  const after = (await MAPPING.load!(tx, ctx.tenantId, id))!;
  await auditConfig(tx, ctx, 'mapping', 'update', id, before, after);
  return after;
}
