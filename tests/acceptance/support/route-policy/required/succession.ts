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

/** A3 / DEC-343④：提示继承继任者字段权限，首次与重放仍共用 A2 的公共投影。 */
const LEFT_PROJECTED: Obligation = {
  perm: 'guard:succession.successorLeftProjected',
  at: [
    { role: 'call', unit: `${S}/projection.ts#projectSuccession`, anchor: 'fields.has(GOVERNING_FIELD[key] ?? key)' },
    { role: 'const', unit: `${S}/projection.ts#GOVERNING_FIELD`, anchor: "successorLeft: 'successorEmployeeId'" },
  ],
};

export const SUCCESSION: RequiredTable = {
  [`GET ${BASE}/maps/org`]: [
    {
      perm: 'obj:Succession.Map:view',
      facts: ['object:objectContext'],
      need: { scope: 'list' },
      at: [
        {
          role: 'call',
          unit: `${S}/org-map-routes.ts#registerOrgMapRoutes`,
          anchor: "await successionContext(c, deps, 'map')",
        },
        ...CONTEXT,
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>map',
          anchor: "object( 'Map'",
        },
        {
          role: 'scope',
          unit: `${S}/org-map-routes.ts#registerOrgMapRoutes`,
          anchor: "await readMapDisplayScope(tx, displayCtx, 'org', supplied, 'submitted')",
        },
      ],
    },
    {
      perm: 'guard:succession.selfHidden',
      note: '请求当日 SELF 谓词对组织与嵌套职位目标判定，空记录集合也按目标删除 successors / successorCount 键',
      at: [
        {
          role: 'call',
          unit: `${S}/org-map-routes.ts#registerOrgMapRoutes`,
          anchor: 'await hiddenMapTargets(tx, ctx, targets, today)',
        },
        {
          role: 'impl',
          unit: `${S}/map-card-reader.ts#hiddenMapTargets`,
          anchor: 'selfRecordHiddenSql(',
        },
      ],
    },
    ...[
      {
        kind: 'record',
        object: 'Record',
        branch: 'mapRecords',
        predicate: 'succession.recordScope(org ∪ creator)',
        unit: 'record-read.ts#listMapRecordRows',
        anchor: "conditions(visibility, { status: 'active' })",
      },
      {
        kind: 'healthResult',
        object: 'HealthResult',
        branch: 'mapHealth',
        predicate: 'succession.healthScope',
        unit: 'health-results.ts#readHealthResults',
        anchor: 'scopeSql(scope, { org: sql`v.org_id` })',
      },
      {
        kind: 'riskResult',
        object: 'RiskResult',
        branch: 'mapRisk',
        predicate: 'succession.riskScope',
        unit: 'risk-store.ts#readRiskRows',
        anchor: 'scopeSql(scope, { org: sql`p.org_id`, creator: sql`r.assigned_by` })',
      },
    ].map((item): Obligation => ({
      perm: `obj:Succession.${item.object}:view`,
      purpose: `disclosure:${item.branch}`,
      facts: ['object:object.* 动作'],
      need: { scope: 'list', predicate: item.predicate },
      at: [
        {
          role: 'call',
          unit: `${S}/map-card-reader.ts#mapObjectAccess`,
          anchor: "await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(kind), fields: [] })",
        },
        {
          role: 'const',
          unit: `packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>${item.kind}`,
          anchor: `object( '${item.object}'`,
        },
        { role: 'scope', unit: `${S}/${item.unit}`, anchor: item.anchor },
      ],
    })),
  ],
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
    LEFT_PROJECTED,
  ],
  [`GET ${BASE}/records/:id`]: [
    view(`router.get(\`\${RECORDS}/:id\`, async (c) => { ${VIEW}`),
    SELF_HIDDEN,
    LEFT_PROJECTED,
  ],
  [`POST ${RECORDS_PATH}`]: [...change('create'), TARGET_IN_SCOPE, LEFT_PROJECTED],
  [`PUT ${RECORDS_PATH}/:id`]: [...change('update'), IMMUTABLE, SELF_HIDDEN, LEFT_PROJECTED],
  [`POST ${RECORDS_PATH}/end`]: [...change('update', 'end'), SELF_HIDDEN, LEFT_PROJECTED],
  [`DELETE ${RECORDS_PATH}/:id`]: [...change('delete'), SELF_HIDDEN],
  [`GET ${BASE}/successor-candidates`]: [...candidates('create'), ...candidates('update')],
};

/** B2a：配置对象看全部；首次与重放共享 A2 的对象／按钮复核；平台命令只认平台运营。 */
const CONFIG_ROUTES = `${S}/config-routes.ts#registerSuccessionConfigRoutes`;
function configRequired(
  key: 'population' | 'ruleSettings' | 'riskLevel' | 'healthLevel',
  operation: 'view' | 'create' | 'update' | 'delete',
  buttonCode: 'view' | 'create' | 'update' | 'delete' | 'reorder' = operation,
) {
  const name = {
    population: 'Population',
    ruleSettings: 'RuleSettings',
    riskLevel: 'RiskLevel',
    healthLevel: 'HealthLevel',
  }[key];
  const code = `Succession.${name}`;
  let entry: Evidence;
  if (operation === 'view') {
    entry =
      key === 'population' || key === 'ruleSettings'
        ? { role: 'call', unit: CONFIG_ROUTES, anchor: `await successionContext(c, deps, '${key}')` }
        : {
            role: 'call',
            unit: `${S}/levels-routes.ts#registerLevelReads`,
            anchor: 'await successionContext(c, deps, spec.object)',
          };
  } else {
    entry = {
      role: 'call',
      unit: SUCCESSION_CONTEXT,
      anchor: 'await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision)',
    };
  }
  const constant: Evidence = {
    role: 'const',
    unit: `packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>${key}`,
    anchor: {
      population: "object('Population'",
      ruleSettings: "object( 'RuleSettings'",
      riskLevel: "levelObject('RiskLevel')",
      healthLevel: "levelObject('HealthLevel')",
    }[key],
  };
  const obligations: Obligation[] = [
    { perm: `obj:${code}:${operation}`, facts: ['object:objectContext'], at: [entry, ...CONTEXT, constant] },
  ];
  if (operation !== 'view')
    obligations.push({
      perm: `btn:${code}#${buttonCode}@${operation === 'create' || buttonCode === 'reorder' ? 'list' : 'detail'}`,
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
        constant,
      ],
    });
  return obligations;
}
Object.assign(SUCCESSION, {
  [`GET ${BASE}/maps/position`]: [
    {
      perm: 'obj:Succession.Map:view',
      facts: ['object:objectContext'],
      need: { scope: 'list', predicate: 'succession.positionMapScope' },
      note: 'C3 显示集合由 C1 保存条件与当前范围决定；SELF 和字段权只裁剪卡片继任者披露',
      at: [
        {
          role: 'call',
          unit: `${S}/position-map-routes.ts#registerPositionMapRoutes`,
          anchor: "await successionContext(c, bound, 'map')",
        },
        ...CONTEXT,
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>map',
          anchor: "object( 'Map'",
        },
        {
          role: 'scope',
          unit: `${S}/position-map.ts#readPositionMap`,
          anchor: "const ids = await readMapDisplayScope(tx, display, 'position')",
        },
        {
          role: 'impl',
          unit: `${S}/map-display.ts#positionScope`,
          anchor: 'const allowed = new Set((await mapPositions(tx, ctx.tenantId, ctx.today ?? ctx.asOf, ctx.scope))',
        },
      ],
    },
    {
      perm: 'obj:Succession.RiskResult:view',
      purpose: 'disclosure:risk',
      facts: ['object:object.* 动作'],
      need: { scope: 'list', predicate: 'succession.riskScope' },
      note: '风险结果和无结果默认颜色均须独立对象查看权、当前范围和风险字段权',
      at: [
        {
          role: 'call',
          unit: `${S}/position-map.ts#positionRiskCards`,
          anchor:
            "await bound.authorize({ ...ctx, action: 'object.view', resource: codeOf('riskResult'), fields: [] })",
        },
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>riskResult',
          anchor: "object( 'RiskResult'",
        },
        {
          role: 'scope',
          unit: `${S}/risk-store.ts#readRiskRows`,
          anchor: 'scopeSql(scope, { org: sql`p.org_id`, creator: sql`r.assigned_by` })',
        },
        { role: 'scope', unit: `${S}/position-map.ts#positionRiskCards`, anchor: 'if (!permitted.has(id)) return []' },
      ],
    },
  ],
  [`GET ${BASE}/maps/:kind/preferences`]: [
    {
      perm: 'obj:Succession.Map:view',
      facts: ['object:objectContext'],
      at: [
        {
          role: 'call',
          unit: `${S}/map-routes.ts#registerMapRoutes`,
          anchor: "await successionContext(c, deps, 'map')",
        },
        ...CONTEXT,
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>map',
          anchor: "object( 'Map'",
        },
      ],
    },
  ],
  [`PUT ${BASE}/maps/:kind/preferences`]: [
    {
      perm: 'guard:succession.preferenceIds',
      note: '本人偏好内引用的组织按当前范围验证',
      at: [
        {
          role: 'call',
          unit: `${S}/map-routes.ts#registerMapRoutes`,
          anchor: 'await resolveMapDisplayConditions(',
        },
        {
          role: 'impl',
          unit: `${S}/map-display.ts#resolveMapDisplayConditions`,
          anchor:
            "if (ids.some((id) => !orgs.some((o) => o.id === id))) throw new AppError('NOT_FOUND', '显示组织不存在')",
        },
      ],
    },
    {
      perm: 'obj:Succession.Map:view',
      facts: ['object:objectContext'],
      at: [
        { role: 'call', unit: `${S}/map-routes.ts#mapAccess`, anchor: "await successionContext(c, bound, 'map')" },
        ...CONTEXT,
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>map',
          anchor: "object( 'Map'",
        },
      ],
    },
  ],
  [`POST ${BASE}/maps/org/compute-stats`]: [
    {
      perm: 'obj:Succession.Map:view',
      facts: ['object:objectContext'],
      at: [
        { role: 'call', unit: `${S}/map-routes.ts#mapAccess`, anchor: "await successionContext(c, bound, 'map')" },
        ...CONTEXT,
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>map',
          anchor: "object( 'Map'",
        },
      ],
    },
    {
      perm: 'btn:Succession.Map#computeStats@list',
      facts: ['button:button()'],
      at: [
        {
          role: 'call',
          unit: `${S}/map-routes.ts#computeAccess`,
          anchor: "await button(bound, access.ctx, codeOf('map'), 'computeStats', 'list')",
        },
        {
          role: 'impl',
          unit: `${MRA}#button`,
          anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
        },
      ],
    },
    {
      perm: 'guard:succession.mapDisplay',
      note: '请求人当前范围 ∩ 地图显示；重放复核原冻结集合',
      at: [
        {
          role: 'call',
          unit: `${S}/map-routes.ts#registerMapRoutes`,
          anchor: "await readMapDisplayScope(tx, { ...ctx, scope, asOf }, 'org', body, 'submitted')",
        },
        {
          role: 'impl',
          unit: `${S}/map-display.ts#readMapDisplayScope`,
          anchor: 'if (!ctx.scope.hasDataPermission) return []',
        },
        {
          role: 'call',
          unit: `${S}/map-display.ts#readMapDisplayScope`,
          anchor: 'await resolveMapDisplayConditions(tx, ctx, kind, supplied, origin)',
        },
        {
          role: 'impl',
          unit: `${S}/map-display.ts#resolveMapDisplayConditions`,
          anchor:
            "if (ids.some((id) => !orgs.some((o) => o.id === id))) throw new AppError('NOT_FOUND', '显示组织不存在')",
        },
      ],
    },
  ],
  [`GET ${BASE}/populations`]: configRequired('population', 'view'),
  [`GET ${BASE}/populations/:id`]: configRequired('population', 'view'),
  [`POST ${BASE}/populations`]: configRequired('population', 'create'),
  [`PUT ${BASE}/populations/:id`]: configRequired('population', 'update'),
  [`DELETE ${BASE}/populations/:id`]: configRequired('population', 'delete'),
  [`GET ${BASE}/rule-settings/:kind`]: configRequired('ruleSettings', 'view'),
  [`PUT ${BASE}/rule-settings/:kind`]: configRequired('ruleSettings', 'update'),
  'POST /api/platform/succession/rules/recompile': [],
});

/** B3b：三条读口与重试共用 calc-read 范围谓词；重试的 before 在 ledgerExit 中取锁后重判。 */
function calcRequired(retry = false): Obligation[] {
  const constant: Evidence = {
    role: 'const',
    unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>calcRun',
    anchor: "object( 'CalcRun'",
  };
  const route = `${S}/calc-routes.ts#registerCalcRoutes`;
  const obligations: Obligation[] = [
    {
      perm: `obj:Succession.CalcRun:${retry ? 'update' : 'view'}`,
      facts: ['object:objectContext', 'object:object.* 动作'],
      at: [
        retry
          ? {
              role: 'call',
              unit: SUCCESSION_CONTEXT,
              anchor: 'await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision)',
            }
          : { role: 'call', unit: route, anchor: "await successionContext(c, deps, 'calcRun')" },
        {
          role: 'impl',
          unit: `${S}/calc-read.ts#calcAccess`,
          anchor: "action: 'object.view', resource: codeOf('calcRun')",
        },
        ...CONTEXT,
        constant,
      ],
    },
    {
      perm: 'guard:succession.calcVisible',
      at: [
        { role: 'call', unit: `${S}/calc-read.ts#readCalcRuns`, anchor: 'whole(scope, ctx)' },
        { role: 'impl', unit: `${S}/calc-read.ts#whole`, anchor: 'calcRowsVisible(scope, ctx.tenantId' },
      ],
    },
  ];
  if (retry)
    obligations.push({
      perm: 'obj:Succession.CalcRun:view',
      facts: ['object:object.* 动作'],
      at: [
        { role: 'call', unit: `${S}/calc-read.ts#calcAccess`, anchor: 'await requirePermission(bound.authorize' },
        {
          role: 'impl',
          unit: `${S}/calc-read.ts#calcAccess`,
          anchor: "action: 'object.view', resource: codeOf('calcRun')",
        },
        constant,
      ],
    });
  if (retry)
    obligations.push(
      {
        perm: 'btn:Succession.CalcRun#retry@detail',
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
          constant,
        ],
      },
      {
        perm: 'guard:succession.calcRetryScope',
        at: [
          { role: 'call', unit: route, anchor: 'await requireCalcRetryScope(tx, deps, ctx, id)' },
          {
            role: 'impl',
            unit: `${S}/calc-read.ts#requireCalcRetryScope`,
            anchor: "reason: 'RUN_SCOPE_EXCEEDS_REQUESTER'",
          },
        ],
      },
    );
  return obligations.map((obligation) =>
    obligation.perm.startsWith('obj:')
      ? {
          ...obligation,
          need: { scope: 'guard' as const, guard: 'succession.calcVisible' },
          at: [
            ...obligation.at,
            { role: 'scope' as const, unit: `${S}/calc-read.ts#readCalcRuns`, anchor: 'whole(scope, ctx)' },
          ],
        }
      : obligation,
  );
}
Object.assign(SUCCESSION, {
  [`GET ${BASE}/calc-runs`]: calcRequired(),
  [`GET ${BASE}/calc-runs/:id`]: calcRequired(),
  [`GET ${BASE}/calc-runs/:id/failures`]: calcRequired(),
  [`POST ${BASE}/calc-runs/:id/retry`]: calcRequired(true),
  'POST /api/platform/succession/jobs/run': [],
});

/** B5：读结果按 SQL 范围；赋值与队列按当前授权，重放保留原集合。 */
function healthRequired(mode: 'read' | 'assign' | 'reset' | 'compute'): Obligation[] {
  const queue = mode === 'reset' || mode === 'compute',
    map = mode === 'compute';
  const key = map ? 'map' : 'healthResult',
    code = map ? 'Map' : 'HealthResult';
  const operation = mode === 'read' || map ? 'view' : 'update';
  const unit = queue
    ? `${S}/health-routes.ts#queueAccess`
    : mode === 'assign'
      ? `${WS}#checkWriteAccess`
      : `${S}/health-routes.ts#registerHealthRoutes`;
  const anchor = queue
    ? map
      ? "await successionContext(c, bound, 'map')"
      : "object: 'healthResult', operation: 'update'"
    : mode === 'assign'
      ? 'const ctx = await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision)'
      : "await successionContext(c, deps, 'healthResult')";
  const constant: Evidence = {
    role: 'const',
    unit: `packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>${key}`,
    anchor: `object( '${code}'`,
  };
  const obligations: Obligation[] = [
    {
      perm: `obj:Succession.${code}:${operation}`,
      facts: mode === 'read' ? ['object:objectContext', 'object:object.* 动作'] : ['object:objectContext'],
      need:
        mode === 'read'
          ? { scope: 'list' }
          : { scope: 'guard', guard: queue ? 'succession.healthQueue' : 'succession.healthOrg' },
      at: [
        { role: 'call', unit, anchor },
        ...CONTEXT,
        ...(mode === 'read'
          ? [
              {
                role: 'call' as const,
                unit: `${S}/health-results.ts#healthAccess`,
                anchor: 'await requirePermission(bound.authorize',
              },
              {
                role: 'impl' as const,
                unit: `${S}/health-results.ts#healthAccess`,
                anchor: "action: 'object.view'",
              },
            ]
          : []),
        constant,
        ...(mode === 'read'
          ? [
              {
                role: 'impl' as const,
                unit: `${S}/health-results.ts#healthAccess`,
                anchor: "action: 'object.view', resource: codeOf('healthResult')",
              },
            ]
          : []),
        {
          role: 'scope',
          unit: queue ? `${S}/health-routes.ts#queueResults` : `${S}/health-results.ts#readHealthResults`,
          anchor: queue ? 'AND NOT EXISTS' : 'scopeSql(scope, { org: sql`v.org_id` })',
        },
      ],
    },
  ];
  if (mode !== 'read')
    obligations.push({
      perm: `btn:Succession.${code}#${map ? 'computeHealth' : mode}@${mode === 'assign' ? 'detail' : 'list'}`,
      facts: ['button:button()'],
      at: [
        {
          role: 'call',
          unit: map ? unit : SUCCESSION_CONTEXT,
          anchor: map
            ? "await button(bound, ctx, codeOf('map'), 'computeHealth', 'list')"
            : 'await button(deps, ctx, codeOf(spec.object), spec.button.code, spec.button.level)',
        },
        {
          role: 'impl',
          unit: `${MRA}#button`,
          anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
        },
        constant,
      ],
    });
  if (mode !== 'read')
    obligations.push({
      perm: `guard:${queue ? 'succession.healthQueue' : 'succession.healthOrg'}`,
      at: [
        {
          role: 'call',
          unit: queue ? `${S}/health-routes.ts#queueResults` : `${S}/health-results.ts#requireHealthOrg`,
          anchor: queue ? 'if (views.length !== ids.length) throw healthMissing()' : 'throw healthMissing()',
        },
      ],
    });
  return obligations;
}
Object.assign(SUCCESSION, {
  [`GET ${BASE}/health-results`]: healthRequired('read'),
  [`PUT ${BASE}/health-results/:orgId`]: healthRequired('assign'),
  [`POST ${BASE}/health-results/reset`]: healthRequired('reset'),
  [`POST ${BASE}/maps/org/compute-health`]: healthRequired('compute'),
});

for (const kind of ['risk', 'health'] as const) {
  const key = kind === 'risk' ? 'riskLevel' : 'healthLevel';
  const path = `${BASE}/${kind}-levels`;
  Object.assign(SUCCESSION, {
    [`GET ${path}`]: configRequired(key, 'view'),
    [`POST ${path}`]: configRequired(key, 'create'),
    [`GET ${path}/:id`]: configRequired(key, 'view'),
    [`PUT ${path}/:id`]: configRequired(key, 'update'),
    [`DELETE ${path}/:id`]: configRequired(key, 'delete'),
    [`PUT ${path}/order`]: configRequired(key, 'update', 'reorder'),
  });
  const result = kind === 'risk' ? 'RiskResult' : 'HealthResult';
  const options = (kind === 'risk' ? ['assign'] : ['assign', 'reset']).flatMap((code): Obligation[] => {
    const at: Evidence[] = [
      {
        role: 'call',
        unit: `${S}/levels-routes.ts#levelOptionAccess`,
        anchor: "await successionContext(c, deps, object, 'update')",
      },
      ...CONTEXT,
    ];
    const group = `options:${code}`;
    return [
      { perm: `obj:Succession.${result}:update`, or: group, facts: ['object:objectContext'], at },
      {
        perm: `btn:Succession.${result}#${code}@${code === 'reset' ? 'list' : 'detail'}`,
        or: group,
        facts: ['button:button()'],
        at: [
          {
            role: 'call',
            unit: `${S}/levels-routes.ts#levelOptionAccess`,
            anchor: `await button(deps, ctx, codeOf(object), '${code}', '${code === 'reset' ? 'list' : 'detail'}')`,
          },
        ],
      },
    ];
  });
  Object.assign(SUCCESSION, { [`GET ${path}/options`]: options });
}

/** D3：逐目标可见性、入口写授权与命令重放都绑定实际实现。 */
function syncRequired(action?: 'sync' | 'retry' | 'abort'): Obligation[] {
  const constant: Evidence = {
    role: 'const',
    unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>syncBatch',
    anchor: "object( 'SyncBatch'",
  };
  const visible: Evidence = {
    role: 'scope',
    unit: `${S}/sync-read.ts#readSync`,
    anchor: 'syncRowsVisible(scope, ctx, sql`b.id`, today)',
  };
  const obj = (operation: string): Obligation => ({
    perm: `obj:Succession.SyncBatch:${operation}`,
    facts: ['object:objectContext', 'object:object.* 动作'],
    need: { scope: 'guard', guard: 'succession.syncVisible' },
    at: [
      constant,
      visible,
      ...CONTEXT,
      operation === 'view'
        ? {
            role: 'call',
            unit: `${S}/sync-read.ts#access`,
            anchor: "action: 'object.view', resource: codeOf('syncBatch')",
          }
        : {
            role: 'call',
            unit: SUCCESSION_CONTEXT,
            anchor: 'await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision)',
          },
    ],
  });
  const result: Obligation[] = [
    obj('view'),
    {
      perm: 'guard:succession.syncVisible',
      at: [
        { ...visible, role: 'call' },
        { role: 'impl', unit: `${S}/sync-read.ts#syncRowsVisible`, anchor: 'syncTargetVisible(scope, viewer' },
      ],
    },
  ];
  if (action)
    result.push(
      obj(action === 'sync' ? 'create' : 'update'),
      {
        perm: `btn:Succession.SyncBatch#${action}@${action === 'sync' ? 'list' : 'detail'}`,
        facts: ['button:button()'],
        at: [
          constant,
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
        ],
      },
      {
        perm: action === 'abort' ? 'guard:succession.syncAdmin' : 'guard:succession.syncRequestScope',
        at:
          action === 'abort'
            ? [
                { role: 'call', unit: `${S}/sync-routes.ts#writeSync`, anchor: 'await syncAdmin(tx, ctx)' },
                { role: 'impl', unit: `${S}/sync-read.ts#syncAdmin`, anchor: "p.code='standard_succession_admin'" },
              ]
            : [
                {
                  role: 'call',
                  unit: `${S}/sync-routes.ts#writeSync`,
                  anchor: 'await checkTargets(tx, currentPort(), ctx',
                },
                {
                  role: 'impl',
                  unit: `${S}/sync-access.ts#authorizeRequesterTargets`,
                  anchor: "reason: 'BATCH_SCOPE_EXCEEDS_REQUESTER'",
                },
              ],
      },
    );
  return result;
}
Object.assign(SUCCESSION, {
  [`GET ${BASE}/sync-batches`]: syncRequired(),
  [`GET ${BASE}/sync-batches/:id`]: syncRequired(),
  [`GET ${BASE}/sync-batches/:id/items`]: syncRequired(),
  [`GET ${BASE}/sync-batches/:id/targets`]: syncRequired(),
  [`POST ${BASE}/sync`]: syncRequired('sync'),
  [`POST ${BASE}/sync-batches/:id/retry`]: syncRequired('retry'),
  [`POST ${BASE}/sync-batches/:id/abort`]: syncRequired('abort'),
});

// B4：首次命令、重放共用 A2 包装器，冻结集合复用 C1。
const RISK_ROUTES = `${S}/risk-routes.ts#registerRiskRoutes`;
const riskConst: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>riskResult',
  anchor: "object( 'RiskResult'",
};
Object.assign(SUCCESSION, {
  [`POST ${BASE}/maps/position/compute-risk`]: [
    {
      perm: 'obj:Succession.Map:view',
      facts: ['object:objectContext'],
      at: [
        { role: 'call', unit: `${S}/risk-routes.ts#computeAccess`, anchor: "await successionContext(c, bound, 'map')" },
        ...CONTEXT,
        {
          role: 'const',
          unit: 'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS>map',
          anchor: "object( 'Map'",
        },
      ],
    },
    {
      perm: 'btn:Succession.Map#computeRisk@list',
      facts: ['button:button()'],
      at: [
        {
          role: 'call',
          unit: `${S}/risk-routes.ts#computeAccess`,
          anchor: "await button(bound, ctx, codeOf('map'), 'computeRisk', 'list')",
        },
        {
          role: 'impl',
          unit: `${MRA}#button`,
          anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
        },
      ],
    },
    {
      perm: 'guard:succession.riskDisplay',
      at: [
        { role: 'call', unit: RISK_ROUTES, anchor: 'await readMapDisplayScope(' },
        {
          role: 'impl',
          unit: `${S}/map-display.ts#readMapDisplayScope`,
          anchor: 'if (!ctx.scope.hasDataPermission) return []',
        },
      ],
    },
  ],
  [`GET ${BASE}/risk-results`]: [
    {
      perm: 'obj:Succession.RiskResult:view',
      facts: ['object:objectContext'],
      at: [
        {
          role: 'call',
          unit: `${S}/risk-routes.ts#registerRiskResultRoutes`,
          anchor: "await successionContext(c, deps, 'riskResult')",
        },
        ...CONTEXT,
        riskConst,
      ],
    },
  ],
  [`PUT ${BASE}/risk-results/:positionId`]: [
    {
      perm: 'obj:Succession.RiskResult:update',
      facts: ['object:objectContext'],
      at: [
        {
          role: 'call',
          unit: SUCCESSION_CONTEXT,
          anchor: 'await successionContext(c, deps, spec.object, spec.operation, spec.expectedRevision)',
        },
        ...CONTEXT,
        riskConst,
      ],
    },
    {
      perm: 'btn:Succession.RiskResult#assign@detail',
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
        riskConst,
      ],
    },
  ],
});
