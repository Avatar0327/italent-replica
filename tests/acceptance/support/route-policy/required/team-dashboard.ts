/**
 * 必需项表：团队人事看板（modules/analytics/team-dashboard-routes.ts、team-dashboard.ts，F-467，35 §2.1b / AC-HA-06，DEC-763③）。
 * 这是 DEC-415 的例外：没有授权对象，也不读角色数据范围——两个只读 GET 的行范围完全由调用者算出
 * （teamVisibility：本人 + 负责部门 + 汇报链；没有绑定人员档案时范围为空），所以只登记 own 谓词的证据。
 */
import type { Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/team-dashboard';
const ROUTES = 'apps/api/src/modules/analytics/team-dashboard-routes.ts';
const TEAM = 'apps/api/src/modules/analytics/team-dashboard.ts';
const OWN = 'own:analytics.teamDashboard.scope';

const scoped = (path: string): Obligation[] => [
  {
    perm: OWN,
    at: [
      { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'await teamPeople(c, deps)' },
      { role: 'impl', unit: `${ROUTES}#teamPeople`, anchor: 'await teamVisibility(tx,' },
      { role: 'impl', unit: `${ROUTES}#teamPeople`, anchor: 'team.visible' },
      { role: 'impl', unit: `${TEAM}#teamVisibility`, anchor: 'await managerIdentityWithOrgs(tx, viewer)' },
      { role: 'impl', unit: `${TEAM}#teamVisibility`, anchor: 'if (!self) return { visible: sql`false`' },
    ],
  },
];

export const TEAM_DASHBOARD: RequiredTable = {
  [`GET ${BASE}`]: scoped(BASE),
  [`GET ${BASE}/components/:code`]: scoped(`${BASE}/components/:code`),
};
