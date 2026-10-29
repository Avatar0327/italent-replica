/**
 * 人事看板路由（BE-12b）的 F-039 声明：两个只读 GET，权限都是对象 TenantBase.HrDashboard 的查看权
 * （hr-dashboard-routes.ts dashboardContext → objectContext），范围按同一对象的数据范围解析（requestScope，页面编码
 * TenantBase.HrDashboard.list），在 SQL 内先于分页叠加（hr-dashboard.ts visible）。响应只含固定键的数字与 ID，不含业务字段。
 */
import { HR_DASHBOARD_OBJECT } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import { fixed, listScope, noButton, object } from '../../route-policy/presets.js';
import { HR_DASHBOARD_BASE } from './hr-dashboard-routes.js';

const read = (fields: ReturnType<typeof fixed>) =>
  object({
    object: HR_DASHBOARD_OBJECT,
    operation: 'view',
    button: noButton('看板只读，按对象查看权'),
    scope: listScope('hrDashboard.visibility'),
    fields,
  });

export const HR_DASHBOARD_POLICIES = defineTable('hr-dashboard', {
  [`GET ${HR_DASHBOARD_BASE}`]: read(
    fixed(['asOf', 'hasDataPermission', 'indicators'], 'hr-dashboard-routes.ts 概览：固定键，指标值是范围内的计数'),
  ),
  [`GET ${HR_DASHBOARD_BASE}/indicators/:code`]: read(
    fixed(
      ['asOf', 'no', 'code', 'name', 'subject', 'total', 'items', 'page', 'pageSize', 'hasDataPermission'],
      'hr-dashboard-routes.ts 明细：固定键，items 只含范围内的 ID',
    ),
  ),
});
