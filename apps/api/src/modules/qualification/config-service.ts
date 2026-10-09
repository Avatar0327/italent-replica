/**
 * 任职资格的分类、类别、层级、级别、指标类型、编码规则（docs/02_业务建模/23 §3.1、§3.2 QL-R1～R4、§11；设计 §3.1）。
 * - 资源集合由系统填写（DEC-324②）；向下公开缺省 false，有编辑权的管理员可以打开；
 * - 引入岗职务（QL-R1 / R2）：岗职务须对操作人可见（不可见与不存在同一 404），编码 / 名称只有操作人当前对岗职务
 *   该字段有查看权才带出，否则须手填（DEC-309 #4）；
 * - 同一类型下一个岗职务只能关联一个类别 / 级别（DEC-331④）：保存时拦截，提示原文“此职位【…】已有关联的任职类别【…】”；
 * - 分类最多 5 级；有下级或被引用的对象不能删除（409，数据不变）。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { visibleJob, type ModuleScope } from '../permission/module-route-access.js';
import type { ScopedJobKind } from '../permission/module-contracts.js';
import { fieldVisible, QUALIFICATION_LABELS, type QualificationObject } from './access.js';
import type * as input from './input.js';
import { loadRow, view, withJobLinks, type JobLinked, type OwnedView } from './read-model.js';
import {
  audit,
  autoCode,
  bumped,
  guardUnique,
  lockEditable,
  ownerOf,
  referenced,
  rejectInUse,
  requireCodeAvailable,
  rowsOf,
  tableOf,
  type WriteContext,
} from './store.js';

/** 岗职务关联类型 → 职务体系对象（module-route-access JOB_OBJECT_CODES）与提示用名称。 */
export const JOB_KINDS: Readonly<Record<string, { kind: ScopedJobKind; label: string }>> = {
  position: { kind: 'positions', label: '职位' },
  post: { kind: 'posts', label: '职务' },
  sequence: { kind: 'sequences', label: '职务序列' },
  level_type: { kind: 'level-types', label: '职级类别' },
  level: { kind: 'levels', label: '职级' },
  grade: { kind: 'grades', label: '职等' },
};

/** 岗职务对象的读取权限（事务外按当前权限解析）：范围与可见字段；null 表示没有查看权。 */
export type JobAccess = Readonly<
  Partial<Record<ScopedJobKind, { scope: ModuleScope; fields: ReadonlySet<string> | undefined } | null>>
>;

export interface ConfigWriteContext extends WriteContext {
  readonly jobs?: JobAccess;
}

const asOf = (ctx: WriteContext) => tenantLocalDate(ctx.now, ctx.timezone);

async function reload<T>(tx: Tx, ctx: WriteContext, object: QualificationObject, id: string): Promise<T> {
  const row = (await loadRow(tx, ctx.tenantId, object, id))!;
  if (object === 'category' || object === 'level') return (await withJobLinks(tx, ctx.tenantId, object, [row]))[0] as T;
  return view<T>(row);
}

const orgOf = (row: Readonly<Record<string, unknown>> | undefined) => (row?.owner_org_id as string | undefined) ?? null;

/** 岗职务须对操作人可见；返回其当前版本（编码、名称）。 */
async function jobObject(tx: Tx, ctx: ConfigWriteContext, linkType: string, id: string) {
  const meta = JOB_KINDS[linkType]!;
  const access = ctx.jobs?.[meta.kind];
  if (access === null) throw new AppError('FORBIDDEN', `无权查看${meta.label}`);
  if (!access) throw new Error(`未解析${meta.label}的读取范围`);
  // 职务体系读模型返回当前版本（含编码、名称）；契约类型只声明了范围判定用的字段
  const item = (await visibleJob(tx, ctx, access.scope, meta.kind, id, asOf(ctx))) as { code?: string; name?: string };
  return { item, fields: access.fields, label: meta.label };
}

/** 关联岗职务（整组替换）：每个岗职务须可见，同一类型下已被其他对象关联则 409（DEC-331④）。 */
async function replaceJobLinks(
  tx: Tx,
  ctx: ConfigWriteContext,
  object: 'category' | 'level',
  ownerId: string,
  linkType: string | null | undefined,
  ids: readonly string[],
) {
  const [table, key, otherTable] =
    object === 'category'
      ? (['ql_category_job_links', 'category_id', 'ql_categories'] as const)
      : (['ql_level_job_links', 'level_id', 'ql_levels'] as const);
  if (ids.length && !linkType) throw new AppError('VALIDATION_FAILED', '请先选择关联岗职务类型');
  await tx.execute(sql`DELETE FROM ${sql.identifier(table)}
    WHERE tenant_id = ${ctx.tenantId}::uuid AND ${sql.identifier(key)} = ${ownerId}::uuid`);
  for (const jobId of new Set(ids)) {
    const { item, label } = await jobObject(tx, ctx, linkType!, jobId);
    const taken = rowsOf<{ name: string }>(
      await tx.execute(sql`SELECT o.name FROM ${sql.identifier(table)} l
        JOIN ${sql.identifier(otherTable)} o ON o.tenant_id = l.tenant_id AND o.id = l.${sql.identifier(key)}
        WHERE l.tenant_id = ${ctx.tenantId}::uuid AND l.job_link_type = ${linkType}
          AND l.job_object_id = ${jobId}::uuid`),
    )[0];
    if (taken) {
      const kind = object === 'category' ? '任职类别' : '任职级别';
      throw new AppError(
        'CONFLICT',
        `此${label}【${String(item.code ?? item.name)}】已有关联的${kind}【${taken.name}】`,
        {
          reason: 'JOB_ALREADY_LINKED',
        },
      );
    }
    await tx.execute(sql`INSERT INTO ${sql.identifier(table)} (tenant_id, ${sql.identifier(key)}, job_link_type,
      job_object_id) VALUES (${ctx.tenantId}, ${ownerId}, ${linkType}, ${jobId})`);
  }
}

// ── 任职类别分类 ─────────────────────────────────────────────

export async function createCategoryClass(tx: Tx, ctx: WriteContext, body: input.CategoryClassCreate) {
  let level = 1;
  if (body.parentId) {
    const parent = await referenced(tx, ctx, 'categoryClass', body.parentId);
    level = (parent.level as number) + 1;
    if (level > 5) throw new AppError('VALIDATION_FAILED', '任职类别分类最多 5 级', { reason: 'CLASS_TOO_DEEP' });
  }
  await requireCodeAvailable(tx, ctx, 'categoryClass', body.code);
  const owner = await ownerOf(tx, ctx, 'categoryClass', body.ownerOrgId);
  const result = await guardUnique(() =>
    tx.execute(sql`INSERT INTO ql_category_classes (tenant_id, code, name, parent_id, level, display_order, enabled,
      public_down, owner_id, owner_org_id, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${body.code}, ${body.name}, ${body.parentId ?? null}, ${level},
        ${body.displayOrder ?? 0},
        ${body.enabled ?? true}, ${body.publicDown ?? false}, ${owner.ownerId}, ${owner.ownerOrgId},
        ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  const after = await reload<OwnedView>(tx, ctx, 'categoryClass', id);
  await audit(tx, ctx, 'categoryClass', 'create', id, { before: null, after, orgId: owner.ownerOrgId });
  return after;
}

/** 简单字段的原地修改（编码、名称、顺序、启用、向下公开）。 */
async function patchSimple(
  tx: Tx,
  ctx: WriteContext,
  object: QualificationObject,
  id: string,
  body: Record<string, unknown>,
  columns: Readonly<Record<string, string>>,
) {
  const row = await lockEditable(tx, ctx, object, id);
  if (typeof body.code === 'string') await requireCodeAvailable(tx, ctx, object, body.code, id);
  const before = await reload<OwnedView>(tx, ctx, object, id);
  const sets = Object.entries(columns)
    .filter(([field]) => body[field] !== undefined)
    .map(([field, column]) => sql`${sql.identifier(column)} = ${body[field] as never}`);
  const bump = bumped(ctx);
  sets.push(sql`revision = ${bump.revision}`, sql`updated_at = ${bump.updatedAt}`);
  await guardUnique(() =>
    tx.execute(sql`UPDATE ${sql.identifier(tableOf(object))} SET ${sql.join(sets, sql`, `)}
      WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`),
  );
  return { row, before };
}

const CLASS_COLUMNS = {
  code: 'code',
  name: 'name',
  displayOrder: 'display_order',
  enabled: 'enabled',
  publicDown: 'public_down',
};

export async function updateCategoryClass(tx: Tx, ctx: WriteContext, id: string, body: input.CategoryClassPatch) {
  const { row, before } = await patchSimple(tx, ctx, 'categoryClass', id, body, CLASS_COLUMNS);
  const after = await reload<OwnedView>(tx, ctx, 'categoryClass', id);
  await audit(tx, ctx, 'categoryClass', 'update', id, { before, after, orgId: orgOf(row) });
  return after;
}

export async function deleteCategoryClass(tx: Tx, ctx: WriteContext, id: string) {
  const row = await lockEditable(tx, ctx, 'categoryClass', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_category_classes WHERE tenant_id = ${ctx.tenantId} AND parent_id = ${id}::uuid
      UNION ALL SELECT 1 FROM ql_categories WHERE tenant_id = ${ctx.tenantId} AND class_id = ${id}::uuid`,
    message: '该分类下还有子分类或任职类别，不能删除',
    reason: 'CLASS_IN_USE',
  });
  const before = await reload<OwnedView>(tx, ctx, 'categoryClass', id);
  await tx.execute(sql`DELETE FROM ql_category_classes WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'categoryClass', 'delete', id, { before, after: null, orgId: orgOf(row) });
  return before;
}

// ── 任职类别 ────────────────────────────────────────────────

async function insertCategory(
  tx: Tx,
  ctx: ConfigWriteContext,
  body: {
    code?: string;
    name: string;
    classId: string;
    jobLinkType?: string | null;
    enabled?: boolean;
    publicDown?: boolean;
    ownerOrgId?: string;
  },
) {
  const code = await autoCode(tx, ctx, 'category', body.code);
  await requireCodeAvailable(tx, ctx, 'category', code);
  const owner = await ownerOf(tx, ctx, 'category', body.ownerOrgId);
  const result = await guardUnique(() =>
    tx.execute(sql`INSERT INTO ql_categories (tenant_id, code, name, class_id, job_link_type, enabled, public_down,
      owner_id, owner_org_id, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${code}, ${body.name}, ${body.classId}, ${body.jobLinkType ?? null},
        ${body.enabled ?? true}, ${body.publicDown ?? false}, ${owner.ownerId}, ${owner.ownerOrgId},
        ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
  );
  return { id: rowsOf<{ id: string }>(result)[0]!.id, orgId: owner.ownerOrgId };
}

export async function createCategory(tx: Tx, ctx: ConfigWriteContext, body: input.CategoryCreate) {
  await referenced(tx, ctx, 'categoryClass', body.classId);
  const { id, orgId } = await insertCategory(tx, ctx, body);
  await replaceJobLinks(tx, ctx, 'category', id, body.jobLinkType, body.jobLinks ?? []);
  const after = await reload<JobLinked>(tx, ctx, 'category', id);
  await audit(tx, ctx, 'category', 'create', id, { before: null, after, orgId });
  return after;
}

/** 编码 / 名称缺省取自岗职务：只有操作人当前看得到该字段才带出，否则须由请求填写（DEC-309 #4）。 */
async function importedName(
  tx: Tx,
  ctx: ConfigWriteContext,
  linkType: string,
  item: input.CategoryImport['items'][number],
) {
  const { item: job, fields } = await jobObject(tx, ctx, linkType, item.jobObjectId);
  const pick = (field: 'code' | 'name', given: string | undefined) =>
    given ?? (fieldVisible(fields, field) ? (job[field] as string | undefined) : undefined);
  const name = pick('name', item.name);
  if (!name)
    throw new AppError('VALIDATION_FAILED', '请填写名称', { reason: 'NAME_REQUIRED', jobObjectId: item.jobObjectId });
  return { code: pick('code', item.code), name };
}

/** 引入任职类别（QL-R1、AC-QL-01）：每个岗职务生成一个类别并建立关联；整批成功或整批失败。 */
export async function importCategories(tx: Tx, ctx: ConfigWriteContext, body: input.CategoryImport) {
  await referenced(tx, ctx, 'categoryClass', body.classId);
  // 整批同一个所属管理单元，先于逐条解析岗职务定下来（DEC-339）
  const { ownerOrgId } = await ownerOf(tx, ctx, 'category', body.ownerOrgId);
  const items: JobLinked[] = [];
  for (const item of body.items) {
    const named = await importedName(tx, ctx, body.jobLinkType, item);
    const { id, orgId } = await insertCategory(tx, ctx, {
      ...named,
      classId: body.classId,
      jobLinkType: body.jobLinkType,
      ownerOrgId,
    });
    await replaceJobLinks(tx, ctx, 'category', id, body.jobLinkType, [item.jobObjectId]);
    const after = await reload<JobLinked>(tx, ctx, 'category', id);
    await audit(tx, ctx, 'category', 'create', id, { before: null, after, orgId });
    items.push(after);
  }
  return { items };
}

const CATEGORY_COLUMNS = {
  code: 'code',
  name: 'name',
  jobLinkType: 'job_link_type',
  enabled: 'enabled',
  publicDown: 'public_down',
};

export async function updateCategory(tx: Tx, ctx: ConfigWriteContext, id: string, body: input.CategoryPatch) {
  const { row, before } = await patchSimple(tx, ctx, 'category', id, body, CATEGORY_COLUMNS);
  if (body.jobLinks !== undefined || body.jobLinkType !== undefined) {
    const type = body.jobLinkType !== undefined ? body.jobLinkType : (row.job_link_type as string | null);
    const links =
      body.jobLinks ?? (type === row.job_link_type ? (before as JobLinked).jobLinks.map((l) => l.jobObjectId) : []);
    await replaceJobLinks(tx, ctx, 'category', id, type, links);
  }
  const after = await reload<JobLinked>(tx, ctx, 'category', id);
  await audit(tx, ctx, 'category', 'update', id, { before, after, orgId: orgOf(row) });
  return after;
}

export async function deleteCategory(tx: Tx, ctx: WriteContext, id: string) {
  const row = await lockEditable(tx, ctx, 'category', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_standards WHERE tenant_id = ${ctx.tenantId} AND category_id = ${id}::uuid
      UNION ALL SELECT 1 FROM ql_development_channels WHERE tenant_id = ${ctx.tenantId}
        AND target_category_id = ${id}::uuid`,
    message: '该任职类别已有任职资格标准或被发展通道引用，不能删除',
    reason: 'CATEGORY_IN_USE',
  });
  const before = await reload<JobLinked>(tx, ctx, 'category', id);
  await tx.execute(sql`DELETE FROM ql_categories WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'category', 'delete', id, { before, after: null, orgId: orgOf(row) });
  return before;
}

// ── 层级（字典） ─────────────────────────────────────────────

export async function createLayer(tx: Tx, ctx: WriteContext, body: input.LayerCreate) {
  if (!ctx.scope.all) throw new AppError('NOT_FOUND', `${QUALIFICATION_LABELS.layer}不存在`);
  const result = await guardUnique(
    () =>
      tx.execute(sql`INSERT INTO ql_layers (tenant_id, name, display_order, enabled, created_by, created_at, updated_at)
        VALUES (${ctx.tenantId}, ${body.name}, ${body.displayOrder ?? 0}, ${body.enabled ?? true}, ${ctx.userId},
          ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
    '名称',
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  const after = await reload<OwnedView>(tx, ctx, 'layer', id);
  await audit(tx, ctx, 'layer', 'create', id, { before: null, after });
  return after;
}

export async function updateLayer(tx: Tx, ctx: WriteContext, id: string, body: input.LayerPatch) {
  const { before } = await patchSimple(tx, ctx, 'layer', id, body, {
    name: 'name',
    displayOrder: 'display_order',
    enabled: 'enabled',
  });
  const after = await reload<OwnedView>(tx, ctx, 'layer', id);
  await audit(tx, ctx, 'layer', 'update', id, { before, after });
  return after;
}

export async function deleteLayer(tx: Tx, ctx: WriteContext, id: string) {
  await lockEditable(tx, ctx, 'layer', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_levels WHERE tenant_id = ${ctx.tenantId} AND layer_id = ${id}::uuid`,
    message: '该层级下还有任职级别，不能删除',
    reason: 'LAYER_IN_USE',
  });
  const before = await reload<OwnedView>(tx, ctx, 'layer', id);
  await tx.execute(sql`DELETE FROM ql_layers WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'layer', 'delete', id, { before, after: null });
  return before;
}

// ── 任职级别 ────────────────────────────────────────────────

/** 顺序号从低到高、租户内唯一；新建缺省为当前最大 + 1（QL-R2）。 */
async function levelOrder(tx: Tx, ctx: WriteContext, given: number | undefined, exceptId?: string) {
  if (given !== undefined) {
    const taken = rowsOf(
      await tx.execute(sql`SELECT 1 FROM ql_levels WHERE tenant_id = ${ctx.tenantId} AND display_order = ${given}
        AND (${exceptId ?? null}::uuid IS NULL OR id <> ${exceptId ?? null}::uuid)`),
    );
    if (taken.length) throw new AppError('CONFLICT', '顺序号重复，请重新输入', { reason: 'DUPLICATE' });
    return given;
  }
  // 与并发新建串行：锁住租户的编码规则行（级别）
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ql_levels:${ctx.tenantId}`}))`);
  const max = rowsOf<{ max: number | null }>(
    await tx.execute(sql`SELECT max(display_order) AS max FROM ql_levels WHERE tenant_id = ${ctx.tenantId}`),
  )[0]!.max;
  return (max ?? 0) + 1;
}

async function insertLevel(
  tx: Tx,
  ctx: ConfigWriteContext,
  body: {
    code?: string;
    name: string;
    displayOrder?: number;
    layerId?: string | null;
    jobLinkType?: string | null;
    enabled?: boolean;
    publicDown?: boolean;
    ownerOrgId?: string;
  },
) {
  if (body.layerId) await referenced(tx, ctx, 'layer', body.layerId);
  const code = await autoCode(tx, ctx, 'level', body.code);
  await requireCodeAvailable(tx, ctx, 'level', code);
  const order = await levelOrder(tx, ctx, body.displayOrder);
  const owner = await ownerOf(tx, ctx, 'level', body.ownerOrgId);
  const result = await guardUnique(() =>
    tx.execute(sql`INSERT INTO ql_levels (tenant_id, code, name, display_order, layer_id, job_link_type, enabled,
      public_down, owner_id, owner_org_id, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${code}, ${body.name}, ${order}, ${body.layerId ?? null}, ${body.jobLinkType ?? null},
        ${body.enabled ?? true}, ${body.publicDown ?? false}, ${owner.ownerId}, ${owner.ownerOrgId},
        ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
  );
  return { id: rowsOf<{ id: string }>(result)[0]!.id, orgId: owner.ownerOrgId };
}

export async function createLevel(tx: Tx, ctx: ConfigWriteContext, body: input.LevelCreate) {
  const { id, orgId } = await insertLevel(tx, ctx, body);
  await replaceJobLinks(tx, ctx, 'level', id, body.jobLinkType, body.jobLinks ?? []);
  const after = await reload<JobLinked>(tx, ctx, 'level', id);
  await audit(tx, ctx, 'level', 'create', id, { before: null, after, orgId });
  return after;
}

/** 引入任职级别（QL-R2）：每个职级 / 职等生成一个级别，顺序号依次递增。 */
export async function importLevels(tx: Tx, ctx: ConfigWriteContext, body: input.LevelImport) {
  const { ownerOrgId } = await ownerOf(tx, ctx, 'level', body.ownerOrgId);
  const items: JobLinked[] = [];
  for (const item of body.items) {
    const named = await importedName(tx, ctx, body.jobLinkType, item);
    const { id, orgId } = await insertLevel(tx, ctx, {
      ...named,
      layerId: body.layerId ?? null,
      jobLinkType: body.jobLinkType,
      ownerOrgId,
    });
    await replaceJobLinks(tx, ctx, 'level', id, body.jobLinkType, [item.jobObjectId]);
    const after = await reload<JobLinked>(tx, ctx, 'level', id);
    await audit(tx, ctx, 'level', 'create', id, { before: null, after, orgId });
    items.push(after);
  }
  return { items };
}

const LEVEL_COLUMNS = {
  code: 'code',
  name: 'name',
  displayOrder: 'display_order',
  layerId: 'layer_id',
  jobLinkType: 'job_link_type',
  enabled: 'enabled',
  publicDown: 'public_down',
};

export async function updateLevel(tx: Tx, ctx: ConfigWriteContext, id: string, body: input.LevelPatch) {
  if (body.displayOrder !== undefined) await levelOrder(tx, ctx, body.displayOrder, id);
  if (body.layerId) await referenced(tx, ctx, 'layer', body.layerId);
  const { row, before } = await patchSimple(tx, ctx, 'level', id, body, LEVEL_COLUMNS);
  if (body.jobLinks !== undefined || body.jobLinkType !== undefined) {
    const type = body.jobLinkType !== undefined ? body.jobLinkType : (row.job_link_type as string | null);
    const links =
      body.jobLinks ?? (type === row.job_link_type ? (before as JobLinked).jobLinks.map((l) => l.jobObjectId) : []);
    await replaceJobLinks(tx, ctx, 'level', id, type, links);
  }
  const after = await reload<JobLinked>(tx, ctx, 'level', id);
  await audit(tx, ctx, 'level', 'update', id, { before, after, orgId: orgOf(row) });
  return after;
}

export async function deleteLevel(tx: Tx, ctx: WriteContext, id: string) {
  const row = await lockEditable(tx, ctx, 'level', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_standards WHERE tenant_id = ${ctx.tenantId} AND ${id}::uuid = ANY(level_ids)
      UNION ALL SELECT 1 FROM ql_development_channels WHERE tenant_id = ${ctx.tenantId}
        AND target_level_id = ${id}::uuid`,
    message: '该任职级别已被任职资格标准引用，不能删除',
    reason: 'LEVEL_IN_USE',
  });
  const before = await reload<JobLinked>(tx, ctx, 'level', id);
  await tx.execute(sql`DELETE FROM ql_levels WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'level', 'delete', id, { before, after: null, orgId: orgOf(row) });
  return before;
}

// ── 指标类型 ────────────────────────────────────────────────

export async function createTargetType(tx: Tx, ctx: WriteContext, body: input.TargetTypeCreate) {
  if (body.parentId) await referenced(tx, ctx, 'targetType', body.parentId);
  const code = await autoCode(tx, ctx, 'target_type', body.code);
  await requireCodeAvailable(tx, ctx, 'targetType', code);
  const owner = await ownerOf(tx, ctx, 'targetType', body.ownerOrgId);
  const result = await guardUnique(() =>
    tx.execute(sql`INSERT INTO ql_target_types (tenant_id, code, name, parent_id, display_order, enabled, public_down,
      owner_id, owner_org_id, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${code}, ${body.name}, ${body.parentId ?? null}, ${body.displayOrder ?? 0},
        ${body.enabled ?? true}, ${body.publicDown ?? false}, ${owner.ownerId}, ${owner.ownerOrgId},
        ${ctx.userId}, ${ctx.now.toISOString()}, ${ctx.now.toISOString()}) RETURNING id`),
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  const after = await reload<OwnedView>(tx, ctx, 'targetType', id);
  await audit(tx, ctx, 'targetType', 'create', id, { before: null, after, orgId: owner.ownerOrgId });
  return after;
}

export async function updateTargetType(tx: Tx, ctx: WriteContext, id: string, body: input.TargetTypePatch) {
  const { row, before } = await patchSimple(tx, ctx, 'targetType', id, body, CLASS_COLUMNS);
  const after = await reload<OwnedView>(tx, ctx, 'targetType', id);
  await audit(tx, ctx, 'targetType', 'update', id, { before, after, orgId: orgOf(row) });
  return after;
}

export async function deleteTargetType(tx: Tx, ctx: WriteContext, id: string) {
  const row = await lockEditable(tx, ctx, 'targetType', id);
  await rejectInUse(tx, {
    sql: sql`SELECT 1 FROM ql_target_types WHERE tenant_id = ${ctx.tenantId} AND parent_id = ${id}::uuid
      UNION ALL SELECT 1 FROM ql_targets WHERE tenant_id = ${ctx.tenantId} AND type_id = ${id}::uuid`,
    message: '该指标类型下还有下级类型或指标，不能删除',
    reason: 'TARGET_TYPE_IN_USE',
  });
  const before = await reload<OwnedView>(tx, ctx, 'targetType', id);
  await tx.execute(sql`DELETE FROM ql_target_types WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'targetType', 'delete', id, { before, after: null, orgId: orgOf(row) });
  return before;
}

// ── 编码规则（QL-R3：四项，只能编辑） ─────────────────────────

export const CODING_ITEMS = ['category', 'level', 'target_type', 'target'] as const;
export type CodingItem = (typeof CODING_ITEMS)[number];

export interface CodingRuleView {
  readonly id: string | null;
  readonly item: CodingItem;
  readonly enabled: boolean;
  readonly prefix: string;
  readonly nextSeq: number;
  readonly revision: number;
}

/** 未改过的项按缺省值呈现（未启用、无前缀、从 1 起，🟡 原站缺省值未取证）。 */
export async function listCodingRules(tx: Tx, tenantId: string): Promise<CodingRuleView[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT id, item, enabled, prefix, next_seq, revision FROM ql_coding_rules
      WHERE tenant_id = ${tenantId}::uuid`),
  );
  return CODING_ITEMS.map((item) => {
    const row = rows.find((r) => r.item === item);
    return row ? view<CodingRuleView>(row) : { id: null, item, enabled: false, prefix: '', nextSeq: 1, revision: 0 };
  });
}

export async function updateCodingRule(tx: Tx, ctx: WriteContext, item: CodingItem, body: input.CodingRulePatch) {
  if (!ctx.scope.all) throw new AppError('NOT_FOUND', `${QUALIFICATION_LABELS.codingRule}不存在`);
  await tx.execute(sql`INSERT INTO ql_coding_rules (tenant_id, item, created_by, revision)
    VALUES (${ctx.tenantId}, ${item}, ${ctx.userId}, 0) ON CONFLICT (tenant_id, item) DO NOTHING`);
  const current = rowsOf<Record<string, unknown>>(
    await tx.execute(
      sql`SELECT * FROM ql_coding_rules WHERE tenant_id = ${ctx.tenantId} AND item = ${item} FOR UPDATE`,
    ),
  )[0]!;
  if (current.revision !== ctx.expectedRevision) {
    throw new AppError('REVISION_CONFLICT', '编码规则已变更，请刷新后显式重提', {
      expected: ctx.expectedRevision,
      actual: current.revision,
    });
  }
  const before = view<CodingRuleView>(current);
  await tx.execute(sql`UPDATE ql_coding_rules SET enabled = ${body.enabled ?? current.enabled},
    prefix = ${body.prefix ?? current.prefix}, next_seq = ${body.nextSeq ?? current.next_seq},
    revision = ${ctx.expectedRevision + 1}, updated_at = ${ctx.now.toISOString()}
    WHERE tenant_id = ${ctx.tenantId} AND item = ${item}`);
  const after = (await listCodingRules(tx, ctx.tenantId)).find((rule) => rule.item === item)!;
  await audit(tx, ctx, 'codingRule', 'update', after.id!, { before, after });
  return after;
}
