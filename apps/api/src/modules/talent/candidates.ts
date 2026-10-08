/**
 * 新建 / 编辑时的候选（只读，docs/02_业务建模/23 §2.2、§7；DEC-281）：
 * - candidates/dimensions：可被新引用的指标（指标与指标库都已启用，TC-R4），按查看人的指标范围与字段权限；
 * - candidates/description-types：发展建议“类型”下拉（DEC-281④），要求指标的查看权，只列启用的类型；类型是下拉选项
 *   （只返回编号、名称、顺序），不按类型字典的数据范围裁剪。名称是带进指标发展建议里的值（suggestions.typeName），
 *   查看人当前看不到指标的 suggestions 就不带名称（DEC-309）；
 * - candidates/owner-orgs?object=：新建指标库 / 库内分类 / 指标 / 标准分类 / 人才标准（以及编辑标准新加指标关联）时的
 *   所属管理单元——当前用户在人才标准应用里的授权管理单元（DEC-294③ 及补充二）。页面只在有多个时显示下拉，一个时由
 *   系统自动填写，没有时提示无法新建。要求该对象的新建权；人才标准另接受编辑权（编辑按钮 + dimensions 编辑权），
 *   供编辑时新加关联选单元（DEC-316③）。组织的编码 / 名称只在查看人当前对组织对象有这两个字段的查看权、且该组织在
 *   查看人组织员工应用的数据范围内时带出，否则只返回 ID（DEC-309 / DEC-316②：TalentCenter 的授权管理单元不能替代
 *   组织应用的数据范围）。
 */
import { sql, withTenant } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  checkWriteFields,
  fieldVisible,
  listEnvelope,
  scopeColumns,
  talentContext,
  talentScope,
  talentWriteContext,
  trimTalentList,
  viewableFields,
  visibleSql,
  type TalentContext,
  type TalentObject,
} from './access.js';
import { getModuleViewableFields, scopeSql } from '../permission/module-access.js';
import { requestScope } from '../permission/module-route-access.js';
import { creatorSql } from '../permission/scope-audit.js';
import { nameQuery, pageQuery, TALENT_BASE, typeQuery } from './http.js';
import { authorizedUnits } from './owner-units.js';
import * as read from './read-model.js';

/** 由系统填写所属管理单元的对象（发展建议类型是字典，没有所属管理单元）。 */
const OWNER_OBJECTS: readonly TalentObject[] = [
  'library',
  'dimensionCategory',
  'dimension',
  'criterionCategory',
  'criterion',
];

export function registerCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${TALENT_BASE}/candidates/dimensions`, async (c) => {
    const ctx = await talentContext(c, deps, 'dimension');
    const page = pageQuery(c);
    const scope = await talentScope(c, deps, ctx, 'dimension');
    const query = { ...page, type: typeQuery(c), name: nameQuery(c), referenceable: true };
    const visible = visibleSql(scope, scopeColumns('dimension', 'talent_dimensions'));
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      read.listDimensions(tx, ctx.tenantId, { ...query, visible }),
    );
    return c.json({
      ...listEnvelope(page, scope, 'dimension'),
      items: await trimTalentList(deps, ctx, 'dimension', items),
    });
  });

  router.get(`${TALENT_BASE}/candidates/description-types`, async (c) => {
    const ctx = await talentContext(c, deps, 'dimension');
    const page = pageQuery(c);
    const named = fieldVisible(await viewableFields(deps, ctx, 'dimension'), 'suggestions');
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      read.listDescriptionTypes(tx, ctx.tenantId, { ...page, enabled: true, visible: sql`true` }),
    );
    return c.json({
      page: page.page,
      pageSize: page.pageSize,
      items: items.map(({ id, name, displayOrder }) => ({ id, displayOrder, ...(named ? { name } : {}) })),
    });
  });

  router.get(`${TALENT_BASE}/candidates/owner-orgs`, async (c) => {
    const object = ownerObject(c);
    // 只返回当前用户自己的授权管理单元（不按人才标准的数据范围另行放大或缩小）
    const ctx = await candidateContext(c, deps, object);
    const asOf = tenantLocalDate(deps.clock(), ctx.timezone);
    const org = await organizationAccess(c, deps, ctx);
    const units = await withTenant(deps.db, ctx.tenantId, (tx) =>
      authorizedUnits(tx, ctx.tenantId, ctx.userId, asOf, org.visible),
    );
    const items = units.map(({ id, code, name, named }) => ({
      id,
      ...(named && fieldVisible(org.fields, 'code') ? { code } : {}),
      ...(named && fieldVisible(org.fields, 'name') ? { name } : {}),
    }));
    return c.json({ items });
  });
}

/**
 * 候选的功能权限：该对象的新建权；人才标准没有新建权时另接受编辑场景——编辑数据操作权 + 编辑按钮 + dimensions
 * 编辑权（与编辑标准新加关联的授权一致，DEC-316③）。
 */
async function candidateContext(c: Context<TenantEnv>, deps: TenantRouteDeps, object: TalentObject) {
  try {
    return await talentContext(c, deps, object, 'create');
  } catch (error) {
    if (object !== 'criterion' || !(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
    const ctx = await talentWriteContext(c, deps, 'criterion', 'update', 0);
    await checkWriteFields(deps, ctx, 'criterion', 'update', { dimensions: [] });
    return ctx;
  }
}

/**
 * 查看人对组织本身的可见性：组织对象的查看权与字段权，加组织员工应用的当前数据范围（与组织列表同一谓词：
 * 所属组织 ∈ 范围，或“使用用户”规则下的创建人，org/read-model.ts）。没有组织查看权时一个都不带（DEC-309）。
 */
async function organizationAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentContext,
): Promise<{ fields: ReadonlySet<string> | undefined; visible: SQL }> {
  const code = MODULE_OBJECTS.organization.code;
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] }))) {
    return { fields: new Set<string>(), visible: sql`false` };
  }
  const scope = await requestScope(c, deps, ctx, code);
  const orgId = sql`v.org_id`;
  return {
    fields: await getModuleViewableFields(deps, ctx, code),
    visible: scopeSql(scope, {
      org: orgId,
      creator: creatorSql(ctx.tenantId, orgId, 'org.create', 'organization'),
    }),
  };
}

function ownerObject(c: Context): TalentObject {
  const value = c.req.query('object') as TalentObject | undefined;
  if (!value || !OWNER_OBJECTS.includes(value)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'object 必须为 library、dimensionCategory、dimension、criterionCategory 或 criterion',
    );
  }
  return value;
}
