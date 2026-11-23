/**
 * 必需项表：人事流程看板（modules/analytics/hr-process-dashboard-routes.ts，R2 BE-13c、F-547）。GET 经 processContext →
 * objectContext 判对象 TenantBase.HrProcessDashboard 的查看权（授权项“人事分析 - 人事流程看板 查看”）；数据范围在同一对象上
 * 解析（requestScope），与审批披露（参与人 / adminScope）一起在 hr-process-dashboard.ts 的 SQL 内叠加，先于分页。
 * 审批管理员分支（转交 / 干预按钮 + 业务范围）只放宽可见的审批实例，登记为披露义务（同审批中心异常管理员交接）。
 */
import { list, SCOPE_AT } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/analytics/hr-process-dashboard';
const EXPORT = `${BASE}/components/:code/export`;
const ROUTES = 'apps/api/src/modules/analytics/hr-process-dashboard-routes.ts';
const DATA = 'apps/api/src/modules/analytics/hr-process-dashboard.ts';
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
    ...(path === EXPORT
      ? ([
          { role: 'scope', unit: `${DATA}#facts`, anchor: 'c.approval' },
          { role: 'scope', unit: `${DATA}#hrProcessPage`, anchor: 'c.approval' },
          { role: 'impl', unit: `${DATA}#hrProcessPage`, anchor: ') AS visible_instance' },
          { role: 'impl', unit: `${DATA}#hrProcessPage`, anchor: 'instanceId: row.visible_instance' },
        ] satisfies Evidence[])
      : []),
  ] satisfies Evidence[],
});

const read = (path: string): Obligation[] => [
  view(path),
  approvalAdmin(path, 'adminTransfer'),
  approvalAdmin(path, 'adminIntervene'),
];

const exportView = view(EXPORT);

export const HR_PROCESS_DASHBOARD: RequiredTable = {
  [`GET ${BASE}`]: read(BASE),
  [`GET ${BASE}/components/:code`]: read(`${BASE}/components/:code`),
  [`GET ${EXPORT}`]: [
    {
      ...exportView,
      need: list('hrProcessDashboard.visibility'),
      note: 'CSV 固定投影：通用六列，7.2.05 按在途明细顺序加通用键，沿用分页明细行和披露',
      at: [
        ...exportView.at,
        {
          role: 'scope',
          unit: `${ROUTES}#processContext`,
          anchor: 'const scope = await requestScope(c, deps, base, HR_PROCESS_DASHBOARD_OBJECT)',
        },
        {
          role: 'call',
          unit: `${ROUTES}#route:GET ${EXPORT}`,
          anchor: 'hrProcessPage(tx, component.code, p, filter, COMPONENT_EXPORT_PAGE)',
        },
        { role: 'scope', unit: `${DATA}#facts`, anchor: 'employmentVisibilitySql(c.scope,' },
        { role: 'scope', unit: `${DATA}#facts`, anchor: 'scopeSql(c.scope,' },
        { role: 'scope', unit: `${DATA}#businesses`, anchor: 'WHERE u.visible AND' },
        {
          role: 'call',
          unit: `${ROUTES}#route:GET ${EXPORT}`,
          anchor: 'columns: processExportColumns(component)',
        },
        {
          role: 'impl',
          unit: `${ROUTES}#processExportColumns`,
          anchor: "if (component.code === 'inFlightList') return IN_FLIGHT_EXPORT_COLUMNS",
        },
        {
          role: 'const',
          unit: `${ROUTES}#IN_FLIGHT_EXPORT_COLUMNS`,
          anchor: "{ key: 'approvedCount', label: '审批计数' }",
        },
      ],
    },
    approvalAdmin(EXPORT, 'adminTransfer'),
    approvalAdmin(EXPORT, 'adminIntervene'),
  ],
};
