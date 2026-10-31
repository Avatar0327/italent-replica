/**
 * 必需项表：人事流程看板（modules/analytics/hr-process-dashboard-routes.ts，R2 BE-13c）。两个只读 GET 经 processContext →
 * objectContext 判对象 TenantBase.HrProcessDashboard 的查看权（授权项“人事分析 - 人事流程看板 查看”）；数据范围在同一对象上
 * 解析（requestScope），与审批披露（参与人 / adminScope）一起在 hr-process-dashboard.ts 的 SQL 内叠加，先于分页。无写入。
 * 审批管理员分支（转交 / 干预按钮 + 业务范围）只放宽可见的审批实例，登记为披露义务（同审批中心异常管理员交接）。
 */
import { list, SCOPE_AT } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-process-dashboard';
const ROUTES = 'apps/api/src/modules/analytics/hr-process-dashboard-routes.ts';
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJECT = 'TenantBase.HrProcessDashboard';
const ACCESS = 'apps/api/src/modules/approval/access.ts';

const view = (path: string): Obligation => ({
  perm: `obj:${OBJECT}:view`,
  facts: ['object:objectContext', `objectOp:${OBJECT}:view`],
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'const p = await processContext(c, deps)' },
    {
      role: 'impl',
      unit: `${ROUTES}#processContext`,
      anchor: "const base = await objectContext(c, deps, HR_PROCESS_DASHBOARD_OBJECT, 'view')",
    },
    {
      role: 'impl',
      unit: `${MRA}#objectContext`,
      anchor:
        'await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, ' +
        'resource: objectCode, fields: [] })',
    },
    {
      role: 'const',
      unit: 'packages/domain/src/analytics/hr-process-dashboard.ts#HR_PROCESS_DASHBOARD_OBJECT',
      anchor: "'TenantBase.HrProcessDashboard'",
    },
  ] satisfies Evidence[],
});

const approvalAdmin = (path: string, code: 'adminTransfer' | 'adminIntervene'): Obligation => ({
  perm: `btn:TenantBase.ApprovalInstance#${code}@detail`,
  purpose: `disclosure:${code}`,
  need: list('approval.adminScope'),
  facts: ['button:adminScope(buttons)', 'scope:adminScope'],
  note: '审批管理员按钮 + 业务范围内的实例也计入看板（approvalVisible），按钮不足只少看实例，不拒绝请求',
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'const p = await processContext(c, deps)' },
    { role: 'impl', unit: `${ROUTES}#processContext`, anchor: 'approval: await approvalVisible(deps, base)' },
    {
      role: 'impl',
      unit: `${ROUTES}#approvalVisible`,
      anchor: "const admin = await adminScope(deps, base, ['adminTransfer', 'adminIntervene'])",
    },
    {
      role: 'impl',
      unit: `${ACCESS}#adminScope`,
      anchor: "allowed ||= await hasButton(deps, ctx, button, button === 'adminLogs' ? 'list' : 'detail')",
    },
    {
      role: 'impl',
      unit: `${ACCESS}#hasButton`,
      anchor: "action: 'object.button', resource: buttonResource(APPROVAL_INSTANCE_OBJECT, button, level)",
    },
    ...SCOPE_AT['approval.adminScope'],
  ] satisfies Evidence[],
});

const read = (path: string): Obligation[] => [
  view(path),
  approvalAdmin(path, 'adminTransfer'),
  approvalAdmin(path, 'adminIntervene'),
];

export const HR_PROCESS_DASHBOARD: RequiredTable = {
  [`GET ${BASE}`]: read(BASE),
  [`GET ${BASE}/components/:code`]: read(`${BASE}/components/:code`),
};
