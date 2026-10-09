/**
 * 必需项表：审计日志查询（audit/routes.ts）。四个入口都经 auditContext → requirePermission('admin.audit_log')；
 * 入口内的 DEC-197 裁剪（auditViewer）是范围 / 字段元数据，由第二道比较按维度检查。失败命令列表另有 360 相关失败的
 * 披露（survey360FailureVisibility：持“全部活动”者才看匿名链接失败，can(activity, view, viewAll)），不作准入。
 */
import type { Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/audit/routes.ts';
const CONTEXT = {
  role: 'impl',
  unit: `${ROUTES}#auditContext`,
  anchor:
    'await requirePermission(deps.authorize, { tenantId: ' +
    "ctx.tenantId, userId: ctx.userId, action: 'admin.audit_log' })",
} as const;
const REQUIRE = {
  role: 'impl',
  unit: 'apps/api/src/authorization.ts#requirePermission',
  anchor: "if (!(await authorizer(request))) throw new AppError('FORBIDDEN'",
} as const;
const auditLog = (path: string): Obligation => ({
  perm: 'admin:audit_log',
  facts: ['admin:auditContext'],
  at: [
    { role: 'call', unit: `${ROUTES}#route:GET ${path}`, anchor: 'const ctx = await auditContext(c, deps)' },
    CONTEXT,
    REQUIRE,
  ],
});

export const AUDIT: RequiredTable = {
  'GET /api/tenant/audit/data-changes': [auditLog('/api/tenant/audit/data-changes')],
  'GET /api/tenant/audit/data-changes/:id': [auditLog('/api/tenant/audit/data-changes/:id')],
  'GET /api/tenant/audit/operation-logs': [auditLog('/api/tenant/audit/operation-logs')],
  'GET /api/tenant/audit/command-failures': [
    auditLog('/api/tenant/audit/command-failures'),
    ...(['obj:Survey360.Activity:view', 'btn:Survey360.Activity#viewAll@list'] as const).map((perm): Obligation => ({
      perm,
      purpose: 'disclosure:survey360LinkFailures' as const,
      note: '只决定匿名链接失败是否可见（CASE … THEN true / false），不拒绝请求',
      at: [
        {
          role: 'call',
          unit: `${ROUTES}#route:GET /api/tenant/audit/command-failures`,
          anchor: 'filters.push(await survey360FailureVisibility(deps, ctx, sql`${auditCommandFailures.path}`))',
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/survey360/access.ts#survey360FailureVisibility',
          // 作答入口失败审计另要本人不兼任任何活动的被评价人 / 评价者（PR-B 第 3 轮 P2-1）
          anchor:
            "allActivitiesOf(tx, deps, { timezone: 'UTC', ...ctx })) && !(await participatesAnywhere(tx, ctx.userId)",
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/survey360/context.ts#allActivitiesOf',
          anchor: "return can(tx, deps, tenant, 'activity', 'view', BUTTONS.allActivities)",
        },
        {
          role: 'impl',
          unit: 'apps/api/src/modules/survey360/context.ts#can',
          anchor: "return authorize({ ...tenant, action: 'object.button', resource })",
        },
        {
          role: 'const',
          unit: 'packages/domain/src/survey360/catalog.ts#SURVEY360_BUTTONS',
          anchor: "allActivities: 'viewAll'",
        },
      ],
    })),
  ],
};
