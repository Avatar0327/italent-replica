/**
 * 必需项表：继任管理（R3-T05；租户接口 modules/succession/routes.ts、平台接口 platform-routes.ts）。对象操作经
 * access.successionContext → module-route-access.objectContext（对象 SUCCESSION_OBJECTS.record）；路径由 SUCCESSION_BASE
 * 拼出（跨文件常量），证据绑注册函数 registerSuccessionRoutes。实现子 PR 每新增一条路由，按人才盘点（talent-review.ts）
 * 的写法逐端点登记审定过的义务与证据，证据摘要登记在 required/digests/units.ts。
 *
 * A1（记录读侧）：#1 准备度选择器、#2 记录列表 / 详情——读入口只有对象查看权，没有按钮；SELF 过滤与筛选字段可见性是守卫。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/succession';
const S = 'apps/api/src/modules/succession';
const ROUTES = `${S}/routes.ts#registerSuccessionRoutes`;
const ACCESS = `${S}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const RECORD = 'Succession.Record';

const OBJECT_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>record',
  anchor: "object( 'Record'",
};
const CONTEXT: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#successionContext`,
    anchor: 'return objectContext(c, deps, codeOf(object), operation, expectedRevision)',
  },
  {
    role: 'impl',
    unit: `${MRA}#objectContext`,
    anchor:
      'await requirePermission(deps.authorize, { ...ctx, action: `object.${operation}`, ' +
      'resource: objectCode, fields: [] })',
  },
];
const call = (anchor: string): Evidence => ({ role: 'call', unit: ROUTES, anchor });
const VIEW = "const ctx = await successionContext(c, deps, 'record')";

function view(anchor: string): Obligation {
  return { perm: `obj:${RECORD}:view`, facts: ['object:objectContext'], at: [call(anchor), ...CONTEXT, OBJECT_CONST] };
}

/** SELF 过滤（SC-R7，§8.4）：开关为 false 时本人为目标的记录不返回、不计数、详情 404；列表与详情共用 conditions。 */
const SELF_HIDDEN: Obligation = {
  perm: 'guard:succession.selfHidden',
  note: '开关 succession.self_successors_visible = false 且查看人是目标负责人 / 现任 → 记录不可见（SQL 谓词 succession_self_target_sql）',
  at: [
    {
      role: 'call',
      unit: `${S}/record-read.ts#conditions`,
      anchor: 'sql`NOT ${selfRecordHiddenSql(',
    },
    {
      role: 'impl',
      unit: `${S}/read-sql.ts#selfRecordHiddenSql`,
      anchor: 'sql`(${selfSuccessorsHiddenSql(viewer.tenantId)} AND ${selfTargetSql(viewer, columns, today)})`',
    },
  ],
};

export const SUCCESSION: RequiredTable = {
  [`GET ${BASE}/readiness`]: [view(`router.get(\`\${SUCCESSION_BASE}/readiness\`, async (c) => { ${VIEW}`)],
  [`GET ${BASE}/records`]: [
    view(`router.get(RECORDS, async (c) => { ${VIEW}`),
    {
      perm: 'guard:succession.filterFieldVisible',
      note: '带筛选而无对应字段查看权 → 403 FILTER_FIELD_HIDDEN（字段级，只在带筛选时判定）',
      at: [
        {
          role: 'call',
          unit: `${S}/routes.ts#recordFilter`,
          anchor: "await requireFilterVisible(deps, ctx, 'record', field)",
        },
        {
          role: 'impl',
          unit: `${ACCESS}#requireFilterVisible`,
          anchor: "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
        },
      ],
    },
    SELF_HIDDEN,
  ],
  [`GET ${BASE}/records/:id`]: [view(`router.get(\`\${RECORDS}/:id\`, async (c) => { ${VIEW}`), SELF_HIDDEN],
};
