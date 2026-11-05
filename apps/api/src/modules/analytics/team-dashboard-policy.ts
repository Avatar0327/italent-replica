/**
 * 团队人事看板（35 §2.1b、AC-HA-06，DEC-763③）的 F-039 声明。没有授权对象：这是 DEC-415 的例外，对部门负责人 / 直线经理开放，
 * 实现方式是“接口按调用者算范围”（team-dashboard.ts teamVisibility：本人 + 负责部门 + 汇报链），所以登记为 own——
 * 数据按当前用户定位，不判对象查看权，也不读角色数据范围。响应只含固定键的计数、分组与范围内的人员 ID。
 */
import { defineTable } from '../../route-policy/index.js';
import { fixed, own } from '../../route-policy/presets.js';
import { TEAM_DASHBOARD_BASE } from './team-dashboard-routes.js';

const SCOPE = 'analytics.teamDashboard.scope';
const DETAIL_KEYS = [
  'asOf',
  'code',
  'name',
  'kind',
  'group',
  'total',
  'items',
  'page',
  'pageSize',
  'hasDataPermission',
];

export const TEAM_DASHBOARD_POLICIES = defineTable('team-dashboard', {
  [`GET ${TEAM_DASHBOARD_BASE}`]: own({
    predicate: SCOPE,
    fields: fixed(
      ['asOf', 'hasDataPermission', 'components'],
      'team-dashboard-routes.ts 概览：固定键，组件值是团队范围内的计数',
    ),
  }),
  [`GET ${TEAM_DASHBOARD_BASE}/components/:code`]: own({
    predicate: SCOPE,
    fields: fixed(DETAIL_KEYS, 'team-dashboard-routes.ts 明细：固定键，items 只含团队范围内的 ID'),
  }),
});
