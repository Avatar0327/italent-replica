/**
 * 新建带资源集合的对象时的所属管理单元候选（DEC-339，同 #106 talent/candidates.ts 的 owner-orgs）：
 * candidates/owner-orgs?object= 返回当前用户在 Qualification 应用的授权管理单元。页面只在有多个时显示下拉（新建
 * 请求须带 ownerOrgId），一个时由系统自动填写，没有时提示无法新建。要求该对象的新建数据操作权。
 * 组织的编码 / 名称只在查看人当前对组织对象有这两个字段的查看权、且该组织在查看人组织员工应用的数据范围内时带出，
 * 否则只返回 ID（DEC-309 / DEC-316②：任职资格的授权管理单元不能替代组织应用的数据范围）。
 */
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, QUALIFICATION_APP, QUALIFICATION_OWNED_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, scopeSql } from '../permission/module-access.js';
import { requestScope } from '../permission/module-route-access.js';
import { authorizedUnits } from '../permission/owner-units.js';
import { creatorSql } from '../permission/scope-audit.js';
import { fieldVisible, qualificationContext, type QualificationContext, type QualificationObject } from './access.js';

/** 由创建人选所属管理单元的对象：带资源集合、且不随别的对象（标准随类别，不在此列）。 */
const OWNER_OBJECTS: readonly QualificationObject[] = QUALIFICATION_OWNED_OBJECTS.filter(
  (object) => object !== 'standard',
);

export function registerQualificationCandidates(router: Hono<TenantEnv>, deps: TenantRouteDeps, base: string): void {
  router.get(`${base}/candidates/owner-orgs`, async (c) => {
    const object = ownerObject(c);
    // 只返回当前用户自己的授权管理单元（不按任职资格的数据范围另行放大或缩小）
    const ctx = await qualificationContext(c, deps, object, 'create');
    const asOf = tenantLocalDate(deps.clock(), ctx.timezone);
    const org = await organizationAccess(c, deps, ctx);
    const units = await withTenant(deps.db, ctx.tenantId, (tx) =>
      authorizedUnits(tx, ctx.tenantId, ctx.userId, QUALIFICATION_APP, asOf, org.visible),
    );
    const items = units.map(({ id, code, name, named }) => ({
      id,
      ...(named && fieldVisible(org.fields, 'code') ? { code } : {}),
      ...(named && fieldVisible(org.fields, 'name') ? { name } : {}),
    }));
    return c.json({ items });
  });
}

/** 查看人对组织本身的可见性：组织对象的查看权与字段权，加组织员工应用的当前数据范围（同组织列表的谓词）。 */
async function organizationAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
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

function ownerObject(c: Context): QualificationObject {
  const value = c.req.query('object') as QualificationObject | undefined;
  if (!value || !OWNER_OBJECTS.includes(value)) {
    throw new AppError('VALIDATION_FAILED', `object 必须为 ${OWNER_OBJECTS.join('、')} 之一`);
  }
  return value;
}
