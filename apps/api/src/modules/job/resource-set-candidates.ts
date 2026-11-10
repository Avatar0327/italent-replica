/**
 * 职级新建的「所属资源集合」候选（DEC-778④ 沿用 DEC-339①，同 talent/qualification 的 candidates/owner-orgs）：
 * 返回当前用户在职务体系应用的授权管理单元 ID；页面只在有多个时显示下拉，一个时由系统自动填写。要求职级的新建权。
 * 只给 ID：组织的编码 / 名称由页面按查看人的组织权限另行读取，读不到就显示 ID（DEC-309 / DEC-316②），
 * 职务体系的授权管理单元不能替代组织应用的数据范围。
 */
import { withTenant } from '@italent/db';
import { ORG_EMPLOYEE_APP, tenantLocalDate } from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { JOB_OBJECT_CODES, objectContext } from '../permission/module-route-access.js';
import { authorizedUnits } from '../permission/owner-units.js';

export function registerResourceSetCandidates(router: Hono<TenantEnv>, base: string, deps: TenantRouteDeps): void {
  router.get(`${base}/candidates/resource-sets`, async (c) => {
    const ctx = await objectContext(c, deps, JOB_OBJECT_CODES.levels, 'create');
    const asOf = tenantLocalDate(deps.clock(), ctx.timezone);
    const units = await withTenant(deps.db, ctx.tenantId, (tx) =>
      authorizedUnits(tx, ctx.tenantId, ctx.userId, ORG_EMPLOYEE_APP, asOf),
    );
    return c.json({ items: units.map(({ id }) => ({ id })) });
  });
}
