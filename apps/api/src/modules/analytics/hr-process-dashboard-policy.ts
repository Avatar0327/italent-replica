/**
 * 人事流程看板路由（BE-13c）的 F-039 声明：两个只读 GET，权限都是对象 TenantBase.HrProcessDashboard 的查看权
 * （hr-process-dashboard-routes.ts processContext → objectContext），范围按同一对象的数据范围解析（requestScope），
 * 与审批披露（参与人 / 审批管理员范围）取交集后在 SQL 内先于分页叠加。响应只含固定键的数字、ID 与在途明细 14 列。
 */
import { HR_PROCESS_DASHBOARD_OBJECT } from '@italent/domain';
import { defineTable } from '../../route-policy/index.js';
import { fixed, listScope, noButton, object } from '../../route-policy/presets.js';
import { HR_PROCESS_DASHBOARD_BASE } from './hr-process-dashboard-routes.js';

const read = (fields: ReturnType<typeof fixed>) =>
  object({
    object: HR_PROCESS_DASHBOARD_OBJECT,
    operation: 'view',
    button: noButton('看板只读，按对象查看权'),
    scope: listScope('hrProcessDashboard.visibility'),
    fields,
  });

const WINDOW = ['asOf', 'from', 'to', 'hasDataPermission'];

export const HR_PROCESS_DASHBOARD_POLICIES = defineTable('hr-process-dashboard', {
  [`GET ${HR_PROCESS_DASHBOARD_BASE}`]: read(
    fixed([...WINDOW, 'components'], 'hr-process-dashboard-routes.ts 概览：固定键，组件值是范围内的计数'),
  ),
  [`GET ${HR_PROCESS_DASHBOARD_BASE}/components/:code`]: read(
    fixed(
      [...WINDOW, 'no', 'code', 'name', 'module', 'subject', 'total', 'items', 'page', 'pageSize'],
      'hr-process-dashboard-routes.ts 明细：固定键，items 只含范围内的 ID 与在途明细列',
    ),
  ),
});
