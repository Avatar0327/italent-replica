/**
 * 必需项表：继任管理（R3-T05；租户接口 modules/succession/routes.ts、平台接口 platform-routes.ts）。对象操作经
 * access.successionContext → module-route-access.objectContext（对象 SUCCESSION_OBJECTS.record）；路径由 SUCCESSION_BASE
 * 拼出（跨文件常量），证据绑注册函数 registerSuccessionRoutes。实现子 PR 每新增一条路由，按人才盘点（talent-review.ts）
 * 的写法逐端点登记审定过的义务与证据，证据摘要登记在 required/digests/units.ts。
 *
 * A1（记录读侧）：#1 准备度选择器、#2 记录列表 / 详情——读入口只有对象查看权，没有按钮；SELF 过滤与筛选字段可见性是守卫。
 * A2（记录写侧）：#3 新增、#3a 候选、#4 编辑、#5 批量结束、#6 软删除——写入口共用 write-support.ts 的 checkWriteAccess
 * （对象数据操作权 + 按钮 + 载荷字段编辑权），命令事务内 recheck 按当前授权重判（CommandGuard.before）。
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

const WS = `${S}/write-support.ts`;
const SUCCESSION_CONTEXT = `${WS}#checkWriteAccess`;
const LEVEL = { create: 'list', update: 'detail', delete: 'detail', end: 'list' } as const;

/** 写入口：对象数据操作权 + 按钮（checkWriteAccess）；end 属于 update 操作的列表级按钮（§8.1）。 */
function change(operation: 'create' | 'update' | 'delete', button: keyof typeof LEVEL = operation): Obligation[] {
  const entry: Evidence = {
    role: 'call',
    unit: SUCCESSION_CONTEXT,
    anchor: 'const ctx = await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision)',
  };
  return [
    { perm: `obj:${RECORD}:${operation}`, facts: ['object:objectContext'], at: [entry, ...CONTEXT, OBJECT_CONST] },
    {
      perm: `btn:${RECORD}#${button}@${LEVEL[button]}`,
      facts: ['button:button()'],
      at: [
        {
          role: 'call',
          unit: SUCCESSION_CONTEXT,
          anchor: 'await button(deps, ctx, codeOf(spec.object), spec.button.code, spec.button.level)',
        },
        {
          role: 'impl',
          unit: `${MRA}#button`,
          anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
        },
        OBJECT_CONST,
      ],
    },
  ];
}

const RECORDS_PATH = `${BASE}/records`;
/** 新增的范围锚点（§8.4）：目标组织 / 职位所属组织须在操作人范围内，否则与不存在同一个 404；继任者不判范围（DEC-308）。 */
const TARGET_IN_SCOPE: Obligation = {
  perm: 'guard:succession.targetInScope',
  note: '组织继任 = 目标组织；职位继任 = 职位请求当日所属组织（DEC-368①）；范围外与不存在同一个 404',
  at: [
    {
      role: 'call',
      unit: `${S}/record-write.ts#requireTarget`,
      anchor: 'if (!row?.enabled || !row.current || !scopeAllows(ctx.scope, { orgId: target.id }))',
    },
  ],
};

/** 候选下拉：持新增或编辑（对象数据操作权 + 按钮）任一即可；不看数据范围（DEC-308）。 */
function candidates(operation: 'create' | 'update'): Obligation[] {
  const entry: Evidence = {
    role: 'call',
    unit: `${WS}#checkCandidateAccess`,
    anchor: `operation: '${operation}', button: { code: '${operation}', level: '${LEVEL[operation]}' }`,
  };
  const group = `candidates:${operation}`;
  return change(operation).map((obligation) => ({
    ...obligation,
    or: group,
    at: [entry, ...obligation.at.slice(1)],
  }));
}

const IMMUTABLE: Obligation = {
  perm: 'guard:succession.immutableFields',
  note: '目标与继任者建后不可改：带这些键 400 FIELD_IMMUTABLE（在结构校验之前判定）',
  at: [{ role: 'call', unit: `${S}/input.ts#rejectImmutable`, anchor: "reason: 'FIELD_IMMUTABLE'" }],
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
  [`POST ${RECORDS_PATH}`]: [...change('create'), TARGET_IN_SCOPE],
  [`PUT ${RECORDS_PATH}/:id`]: [...change('update'), IMMUTABLE, SELF_HIDDEN],
  [`POST ${RECORDS_PATH}/end`]: [...change('update', 'end'), SELF_HIDDEN],
  [`DELETE ${RECORDS_PATH}/:id`]: [...change('delete'), SELF_HIDDEN],
  [`GET ${BASE}/successor-candidates`]: [...candidates('create'), ...candidates('update')],
};
