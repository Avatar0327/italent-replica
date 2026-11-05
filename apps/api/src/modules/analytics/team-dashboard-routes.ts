/**
 * 团队人事看板（35 §2.1b、AC-HA-06，DEC-763③）只读路由：
 * - GET /api/tenant/analytics/team-dashboard?asOf=&departmentId=&departmentIncludeChildren=：6.01 / 6.03 / 6.08；
 * - GET …/team-dashboard/components/:code?group=&page=&pageSize=：构成数字（或某个分组）的人员明细。
 * 没有授权对象：调用者必须是租户的在职成员（中间件已验），范围完全由调用者的负责部门 + 汇报关系算出（team-dashboard.ts），
 * 不读角色数据范围；绑定了人员档案的成员直接调用都只会得到本人（没有下属时），不报错也不多给别人；
 * 没有绑定人员档案的成员（外部用户）与“组件不存在”同一个 404，不给 200 空看板，也不暴露机器原因。
 * 部门筛选树照原站显示全租户组织（DEC-763④），筛选后的数据仍在上面的范围内。只读，不写台账 / 审计。
 */
import { withTenant } from '@italent/db';
import { TEAM_DASHBOARD_COMPONENTS, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { pageQuery } from '../job/context.js';
import { dateQuery } from './hr-dashboard-routes.js';
import { structurePeopleWhere } from './hr-structure.js';
import { componentMembers, filterPeople, isGrouped, structureComponents } from './hr-structure-board.js';
import { BOARD_EMPLOY_TYPES, departmentFilter, groupQuery, lookupOf } from './hr-structure-routes.js';
import { teamVisibility } from './team-dashboard.js';

export const TEAM_DASHBOARD_BASE = '/api/tenant/analytics/team-dashboard';
const NOT_FOUND_TEXT = '组件不存在';
const SHOWN = new Set<string>(TEAM_DASHBOARD_COMPONENTS.map((item) => item.code));

async function teamPeople(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const tenant = tenantOf(c);
  const asOf = dateQuery(c, 'asOf') ?? tenantLocalDate(deps.clock(), tenant.timezone);
  const filter = departmentFilter(c);
  const loaded = await withTenant(deps.db, tenant.tenantId, async (tx) => {
    const team = await teamVisibility(tx, { tenantId: tenant.tenantId, userId: tenant.userId, asOf });
    const lookup = await lookupOf(tx, tenant.tenantId, asOf);
    if (!team) throw new AppError('NOT_FOUND', NOT_FOUND_TEXT);
    const people = await structurePeopleWhere(
      tx,
      { tenantId: tenant.tenantId, asOf },
      BOARD_EMPLOY_TYPES,
      team.visible,
    );
    return { lookup, people: filterPeople(people, filter, lookup.tree) };
  });
  return { asOf, ...loaded };
}

export function registerTeamDashboardRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(TEAM_DASHBOARD_BASE, async (c) => {
    const { asOf, lookup, people } = await teamPeople(c, deps);
    return c.json({
      asOf,
      components: structureComponents(people, lookup).filter((item) => SHOWN.has(item.code)),
    });
  });

  router.get(`${TEAM_DASHBOARD_BASE}/components/:code`, async (c) => {
    const component = TEAM_DASHBOARD_COMPONENTS.find((item) => item.code === c.req.param('code'));
    if (!component) throw new AppError('NOT_FOUND', NOT_FOUND_TEXT);
    const group = groupQuery(c);
    if (group !== undefined && !isGrouped(component.code)) throw new AppError('VALIDATION_FAILED', '该组件没有分组');
    const page = pageQuery(c);
    const { asOf, lookup, people } = await teamPeople(c, deps);
    const members = componentMembers(component.code, people, lookup, group)!;
    return c.json({
      asOf,
      ...component,
      group: group ?? null,
      total: members.length,
      items: members
        .slice(page.offset, page.offset + page.limit)
        .map((p) => ({ id: p.id, employeeId: p.id, organizationId: p.departmentId })),
      page: page.page,
      pageSize: page.pageSize,
    });
  });
}
