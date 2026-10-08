/**
 * 新建 / 编辑时的候选（只读，docs/02_业务建模/23 §2.2、§7；DEC-281）：
 * - candidates/dimensions：可被新引用的指标（指标与指标库都已启用，TC-R4），按查看人的指标范围与字段权限；
 * - candidates/description-types：发展建议“类型”下拉（DEC-281④），要求指标的查看权，只列启用的类型；类型是下拉选项
 *   （只返回编号、名称、顺序），不按类型字典的数据范围裁剪。名称是带进指标发展建议里的值（suggestions.typeName），
 *   查看人当前看不到指标的 suggestions 就不带名称（DEC-309）；
 * - candidates/owner-orgs?object=：新建指标库 / 库内分类 / 指标 / 标准分类 / 人才标准（以及编辑标准新加指标关联）时的
 *   所属管理单元——当前用户在人才标准应用里的授权管理单元（DEC-294③ 及补充二）。页面只在有多个时显示下拉，一个时由
 *   系统自动填写，没有时提示无法新建。组织的编码 / 名称按查看人当前对组织对象这两个字段的查看权带出，看不到只返回 ID
 *   （DEC-309）。
 */
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  fieldVisible,
  listEnvelope,
  scopeColumns,
  talentContext,
  talentScope,
  trimTalentList,
  viewableFields,
  visibleSql,
  type TalentContext,
  type TalentObject,
} from './access.js';
import { getModuleViewableFields } from '../permission/module-access.js';
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
    // 只返回当前用户自己的授权管理单元，要求该对象的新建权（不按数据范围另行放大或缩小）
    const ctx = await talentContext(c, deps, object, 'create');
    const asOf = tenantLocalDate(deps.clock(), ctx.timezone);
    const units = await withTenant(deps.db, ctx.tenantId, (tx) => authorizedUnits(tx, ctx.tenantId, ctx.userId, asOf));
    const fields = await organizationFields(deps, ctx);
    const items = units.map(({ id, code, name }) => ({
      id,
      ...(fieldVisible(fields, 'code') ? { code } : {}),
      ...(fieldVisible(fields, 'name') ? { name } : {}),
    }));
    return c.json({ items });
  });
}

/** 查看人当前对组织对象的可见字段：没有组织的查看权就一个都不带（DEC-309）。 */
async function organizationFields(deps: TenantRouteDeps, ctx: TalentContext) {
  const code = MODULE_OBJECTS.organization.code;
  if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] }))) {
    return new Set<string>();
  }
  return getModuleViewableFields(deps, ctx, code);
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
