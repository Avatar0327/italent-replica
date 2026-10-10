/**
 * 必需项表：人才盘点准备度字典（modules/talent-review/routes.ts，R3-T04 PR-A）。对象操作经 access.reviewContext →
 * module-route-access.objectContext（对象 TALENT_REVIEW_OBJECTS.readiness）；写入口 reviewWriteContext 叠加 WRITE_BUTTONS
 * 按钮。路径由 TALENT_REVIEW_BASE 拼出（跨文件常量），证据绑注册函数 registerTalentReviewRoutes。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/talent-review/readiness-levels';
const T = 'apps/api/src/modules/talent-review';
const ROUTES = `${T}/routes.ts#registerTalentReviewRoutes`;
const ACCESS = `${T}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const RDY = 'TalentReview.Readiness';
type Operation = 'view' | 'create' | 'update' | 'delete';

const OBJECT_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS>readiness',
  anchor: "object('Readiness'",
};
const CONTEXT: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#reviewContext`,
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
const BUTTON: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#reviewWriteContext`,
    anchor: 'await button(deps, ctx, codeOf(object), code, level)',
  },
  {
    role: 'impl',
    unit: `${MRA}#button`,
    anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
  },
];
const call = (anchor: string): Evidence => ({ role: 'call', unit: ROUTES, anchor });
const VIEW = "const ctx = await reviewContext(c, deps, 'readiness')";
const write = (operation: Exclude<Operation, 'view'>) =>
  `const ctx = await reviewWriteContext(c, deps, 'readiness', '${operation}', revision(c))`;
const LEVEL = { create: 'list', update: 'detail', delete: 'detail' } as const;

function view(anchor: string): Obligation {
  return { perm: `obj:${RDY}:view`, facts: ['object:objectContext'], at: [call(anchor), ...CONTEXT, OBJECT_CONST] };
}
function change(operation: Exclude<Operation, 'view'>): Obligation[] {
  const entry = call(write(operation));
  return [
    { perm: `obj:${RDY}:${operation}`, facts: ['object:objectContext'], at: [entry, ...CONTEXT, OBJECT_CONST] },
    {
      perm: `btn:${RDY}#${operation}@${LEVEL[operation]}`,
      facts: ['button:button()'],
      at: [
        entry,
        ...BUTTON,
        {
          role: 'const',
          unit: `${ACCESS}#WRITE_BUTTONS`,
          anchor: `${operation}: ['${operation}', '${LEVEL[operation]}']`,
        },
      ],
    },
  ];
}

// ---- R3-T04 PR-B1：设置 / 分类 / 角色 / 字段目录（modules/talent-review/config-routes.ts） ----------------------------
const CFG = `${T}/config-routes.ts`;
const SCORING = `${T}/scoring-routes.ts`;
const CATALOG = 'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS';
const cfgView = (
  object: string,
  constKey: string,
  label: string,
  register: string,
  anchor: string,
  file = CFG,
): Obligation => ({
  perm: `obj:${object}:view`,
  facts: ['object:objectContext'],
  at: [
    { role: 'call', unit: `${file}#${register}`, anchor },
    ...CONTEXT,
    { role: 'const', unit: `${CATALOG}>${constKey}`, anchor: `object('${label}'` },
  ],
});
function cfgChange(
  object: string,
  constKey: string,
  label: string,
  register: string,
  operation: Exclude<Operation, 'view'>,
  file = CFG,
): Obligation[] {
  const entry: Evidence = {
    role: 'call',
    unit: `${file}#${register}`,
    anchor: `const ctx = await reviewWriteContext(c, deps, '${constKey}', '${operation}', revision(c))`,
  };
  const objectConst: Evidence = { role: 'const', unit: `${CATALOG}>${constKey}`, anchor: `object('${label}'` };
  const level = operation === 'create' ? 'list' : 'detail';
  return [
    { perm: `obj:${object}:${operation}`, facts: ['object:objectContext'], at: [entry, ...CONTEXT, objectConst] },
    {
      perm: `btn:${object}#${operation}@${level}`,
      facts: ['button:button()'],
      at: [
        entry,
        ...BUTTON,
        { role: 'const', unit: `${ACCESS}#WRITE_BUTTONS`, anchor: `${operation}: ['${operation}', '${level}']` },
      ],
    },
  ];
}
const FILTER_GUARD: Obligation = {
  perm: 'guard:talentReview.filterFieldVisible',
  facts: ['guard:talentReview.filterFieldVisible'],
  note: '带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN（字段级，只在带筛选时判定）',
  at: [
    {
      role: 'call',
      unit: `${CFG}#listResponse`,
      anchor: "if (enabled !== undefined) await requireFilterVisible(deps, ctx, object, 'enabled')",
    },
    {
      role: 'impl',
      unit: `${ACCESS}#requireFilterVisible`,
      anchor: "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
    },
  ],
};
const RENAME_GUARD: Obligation = {
  perm: 'guard:talentReview.configRenameRequiresSeeAll',
  facts: ['guard:talentReview.configRenameRequiresSeeAll'],
  note: '名称实际变化且不是看全部 → 403 NAME_REQUIRES_SEE_ALL（在查重之前判定，不暴露隐藏记录）',
  at: [
    {
      role: 'call',
      unit: `${T}/config-kit.ts#requireSeeAllToRename`,
      anchor: 'if (name !== undefined && name !== before.name && !ctx.scope.all) {',
    },
  ],
};

/** 新建字段时指定成对字段 = 同时修改另一端：条件守卫 + 条件准入（更新权、update 按钮；pairFieldId 编辑权随字段元数据）。 */
const PAIR_UPDATE = 'talentReview.pairRequiresUpdate';
const pairEntry: Evidence = {
  role: 'call',
  unit: `${CFG}#registerFields`,
  anchor: 'if (body.pairFieldId !== undefined) await requirePairUpdate(c, deps, body.pairFieldId)',
};
const pairCall: Evidence = {
  role: 'call',
  unit: `${CFG}#requirePairUpdate`,
  anchor: "const ctx = await reviewWriteContext(c, deps, 'field', 'update', 0)",
};
const FIELD_OBJECT_CONST: Evidence = {
  role: 'const',
  unit: `${CATALOG}>field`,
  anchor: "object('Field'",
};
const PAIR_OBLIGATIONS: Obligation[] = [
  {
    perm: `guard:${PAIR_UPDATE}`,
    facts: [`guard:${PAIR_UPDATE}`],
    note: '条件守卫：请求体带 pairFieldId 时，另需字段更新权与 update 按钮（先于读取另一端）',
    at: [pairEntry],
  },
  {
    perm: 'obj:TalentReview.Field:update',
    purpose: `when:${PAIR_UPDATE}`,
    at: [pairCall, ...CONTEXT, FIELD_OBJECT_CONST],
  },
  {
    perm: 'btn:TalentReview.Field#update@detail',
    purpose: `when:${PAIR_UPDATE}`,
    at: [
      pairCall,
      ...BUTTON,
      { role: 'const', unit: `${ACCESS}#WRITE_BUTTONS`, anchor: "update: ['update', 'detail']" },
    ],
  },
];

/** 分类 / 角色 / 字段目录（B1）与评价规则 / 模块等级（B2，scoring-routes.ts）五条路由；settings 另列（单例，只有读与改）。 */
function cfgObject(
  key: string,
  label: string,
  register: string,
  base: string,
  constName: string,
  file = CFG,
): RequiredTable {
  const object = `TalentReview.${label}`;
  const get = (anchor: string) => cfgView(object, key, label, register, anchor, file);
  const ctx = `const ctx = await reviewContext(c, deps, '${key}')`;
  return {
    [`GET ${BASE_ROOT}/${base}`]: [get(`router.get(${constName}, async (c) => { ${ctx}`), FILTER_GUARD],
    [`GET ${BASE_ROOT}/${base}/:id`]: [get(`router.get(\`\${${constName}}/:id\`, async (c) => { ${ctx}`)],
    [`POST ${BASE_ROOT}/${base}`]: [
      ...cfgChange(object, key, label, register, 'create', file),
      ...(key === 'field' ? PAIR_OBLIGATIONS : []),
    ],
    [`PATCH ${BASE_ROOT}/${base}/:id`]: [...cfgChange(object, key, label, register, 'update', file), RENAME_GUARD],
    [`DELETE ${BASE_ROOT}/${base}/:id`]: cfgChange(object, key, label, register, 'delete', file),
  };
}

const BASE_ROOT = '/api/tenant/talent-review';
const SETTINGS_OBJECT = 'TalentReview.Settings';

// ---- R3-T04 PR-B4：九宫格（modules/talent-review/matrix-routes.ts） -----------------------------------------------
const MTX = `${T}/matrix-routes.ts`;
const MATRIX_OBJECT = 'TalentReview.Matrix';
const matrixConst = (key: string, label: string): Evidence => ({
  role: 'const',
  unit: `${CATALOG}>${key}`,
  anchor: `object('${label}'`,
});
const matrixCall = (register: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${MTX}#${register}`,
  anchor,
});
const matrixView = (anchor: string): Obligation => ({
  perm: `obj:${MATRIX_OBJECT}:view`,
  facts: ['object:objectContext'],
  at: [matrixCall('registerMatrixRoutes', anchor), ...CONTEXT, matrixConst('matrix', 'Matrix')],
});
/** 九宫格写入口：操作权 + 按钮（规则组写入也是九宫格的 update）。 */
function matrixChange(register: string, operation: Exclude<Operation, 'view'>): Obligation[] {
  const entry = matrixCall(
    register,
    `const ctx = await reviewWriteContext(c, deps, 'matrix', '${operation}', revision(c))`,
  );
  const level = operation === 'create' ? 'list' : 'detail';
  return [
    {
      perm: `obj:${MATRIX_OBJECT}:${operation}`,
      facts: ['object:objectContext'],
      at: [entry, ...CONTEXT, matrixConst('matrix', 'Matrix')],
    },
    {
      perm: `btn:${MATRIX_OBJECT}#${operation}@${level}`,
      facts: ['button:button()'],
      at: [
        entry,
        ...BUTTON,
        { role: 'const', unit: `${ACCESS}#WRITE_BUTTONS`, anchor: `${operation}: ['${operation}', '${level}']` },
      ],
    },
  ];
}
const MATRIX_FIELD_REFERENCE = 'talentReview.matrixFieldReference';
/** 引用盘点字段 = 读取字段目录：请求带字段引用时另需字段目录的对象查看权（requireFieldReference）。 */
const matrixReference = (anchor: string): Obligation[] => [
  {
    perm: `guard:${MATRIX_FIELD_REFERENCE}`,
    facts: [`guard:${MATRIX_FIELD_REFERENCE}`],
    note: '条件守卫：请求体带轴 / 第三维度 / 位置字段引用时，另需字段目录的对象查看权，字段可见性在命令内按字段目录范围判定',
    at: [matrixCall('registerMatrixRoutes', anchor)],
  },
  {
    perm: 'obj:TalentReview.Field:view',
    purpose: `when:${MATRIX_FIELD_REFERENCE}`,
    at: [
      {
        role: 'call',
        unit: `${MTX}#requireFieldReference`,
        anchor: "const ctx = await reviewContext(c, deps, 'field')",
      },
      ...CONTEXT,
      FIELD_OBJECT_CONST,
    ],
  },
];
const MATRIX_POSITION_GUARD: Obligation = {
  perm: 'guard:talentReview.matrixPositionRequiresSeeAll',
  facts: ['guard:talentReview.matrixPositionRequiresSeeAll'],
  note: '改位置字段且不是看全部 → 403 MATRIX_POSITION_REQUIRES_SEE_ALL（在查重之前判定，不暴露隐藏九宫格占用）',
  at: [
    {
      role: 'call',
      unit: `${T}/matrix-service.ts#updateMatrix`,
      anchor:
        "if (repoint && !ctx.scope.all) { throw new AppError('FORBIDDEN', '只有能查看全部的人可以修改位置字段', {",
    },
  ],
};
const MATRIX_FILTER_GUARD: Obligation = {
  ...FILTER_GUARD,
  at: [
    {
      role: 'call',
      unit: `${MTX}#registerMatrixRoutes`,
      anchor: "if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'matrix', 'enabled')",
    },
    ...FILTER_GUARD.at.slice(1),
  ],
};
const MTX_BASE = `${BASE_ROOT}/matrices`;
const MATRIX_REQUIRED: RequiredTable = {
  [`GET ${MTX_BASE}`]: [
    matrixView("router.get(MATRICES, async (c) => { const ctx = await reviewContext(c, deps, 'matrix')"),
    MATRIX_FILTER_GUARD,
  ],
  [`GET ${MTX_BASE}/:id`]: [
    matrixView("router.get(`${MATRICES}/:id`, async (c) => { const ctx = await reviewContext(c, deps, 'matrix')"),
  ],
  [`POST ${MTX_BASE}`]: [
    ...matrixChange('registerMatrixRoutes', 'create'),
    ...matrixReference('const fieldScope = await requireFieldReference(c, deps)'),
  ],
  [`PATCH ${MTX_BASE}/:id`]: [
    ...matrixChange('registerMatrixRoutes', 'update'),
    RENAME_GUARD,
    MATRIX_POSITION_GUARD,
    ...matrixReference('const fieldScope = references.length > 0 ? await requireFieldReference(c, deps) : undefined'),
  ],
  [`DELETE ${MTX_BASE}/:id`]: matrixChange('registerMatrixRoutes', 'delete'),
  [`POST ${MTX_BASE}/:id/ratio-groups`]: matrixChange('registerRatioGroupRoutes', 'update'),
  [`PATCH ${MTX_BASE}/:id/ratio-groups/:groupId`]: matrixChange('registerRatioGroupRoutes', 'update'),
  [`DELETE ${MTX_BASE}/:id/ratio-groups/:groupId`]: matrixChange('registerRatioGroupRoutes', 'update'),
};

// ---- R3-T04 PR-B5：计算规则（modules/talent-review/calc-rule-routes.ts） ------------------------------------------------
const CRR = `${T}/calc-rule-routes.ts`;
const CALC_OBJECT = 'TalentReview.CalcRule';
const calcConst: Evidence = { role: 'const', unit: `${CATALOG}>calcRule`, anchor: "object( 'CalcRule'" };
const calcCall = (anchor: string): Evidence => ({ role: 'call', unit: `${CRR}#registerCalcRuleRoutes`, anchor });
const calcView = (anchor: string): Obligation => ({
  perm: `obj:${CALC_OBJECT}:view`,
  facts: ['object:objectContext'],
  at: [calcCall(anchor), ...CONTEXT, calcConst],
});
function calcChange(operation: Exclude<Operation, 'view'>): Obligation[] {
  const entry = calcCall(`const ctx = await reviewWriteContext(c, deps, 'calcRule', '${operation}', revision(c))`);
  const level = operation === 'create' ? 'list' : 'detail';
  return [
    { perm: `obj:${CALC_OBJECT}:${operation}`, facts: ['object:objectContext'], at: [entry, ...CONTEXT, calcConst] },
    {
      perm: `btn:${CALC_OBJECT}#${operation}@${level}`,
      facts: ['button:button()'],
      at: [
        entry,
        ...BUTTON,
        { role: 'const', unit: `${ACCESS}#WRITE_BUTTONS`, anchor: `${operation}: ['${operation}', '${level}']` },
      ],
    },
  ];
}
const CALC_CATALOG = 'talentReview.calcRuleFieldCatalog';
/** 提交计算项目 = 读取字段目录：公式与目标字段只在字段目录范围内可见的字段里解析（requireCatalogAccess）。 */
const calcCatalog = (anchor: string): Obligation[] => [
  {
    perm: `guard:${CALC_CATALOG}`,
    facts: [`guard:${CALC_CATALOG}`],
    note:
      '条件守卫：提交计算项目（POST；PATCH 带 items）时另需字段目录的对象查看权，' +
      '公式与目标字段只在其范围与 name / kind / enabled / systemWritten 列权限内可引用的字段里解析',
    at: [calcCall(anchor)],
  },
  {
    perm: 'obj:TalentReview.Field:view',
    purpose: `when:${CALC_CATALOG}`,
    at: [
      {
        role: 'call',
        unit: `${CRR}#requireCatalogAccess`,
        anchor: "const ctx = await reviewContext(c, deps, 'field')",
      },
      ...CONTEXT,
      FIELD_OBJECT_CONST,
    ],
  },
];
const CALC_FILTER_GUARD: Obligation = {
  ...FILTER_GUARD,
  at: [
    calcCall("if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'calcRule', 'enabled')"),
    ...FILTER_GUARD.at.slice(1),
  ],
};
const CALC_BASE = `${BASE_ROOT}/calc-rules`;
const CALC_REQUIRED: RequiredTable = {
  [`GET ${CALC_BASE}`]: [
    calcView("router.get(CALC_RULES, async (c) => { const ctx = await reviewContext(c, deps, 'calcRule')"),
    CALC_FILTER_GUARD,
  ],
  [`GET ${CALC_BASE}/:id`]: [
    calcView("router.get(`${CALC_RULES}/:id`, async (c) => { const ctx = await reviewContext(c, deps, 'calcRule')"),
  ],
  [`POST ${CALC_BASE}`]: [
    ...calcChange('create'),
    ...calcCatalog('const access = await requireCatalogAccess(c, deps)'),
  ],
  [`PATCH ${CALC_BASE}/:id`]: [
    ...calcChange('update'),
    RENAME_GUARD,
    ...calcCatalog('const access = await patchCatalogAccess(c, deps, body)'),
  ],
  [`DELETE ${CALC_BASE}/:id`]: calcChange('delete'),
};

export const TALENT_REVIEW: RequiredTable = {
  ...CALC_REQUIRED,
  ...MATRIX_REQUIRED,
  ...cfgObject('category', 'Category', 'registerCategories', 'categories', 'CATEGORIES'),
  ...cfgObject('role', 'Role', 'registerRoles', 'roles', 'ROLES'),
  ...cfgObject('field', 'Field', 'registerFields', 'fields', 'FIELDS'),
  ...cfgObject('scoreRule', 'ScoreRule', 'registerScoreRules', 'score-rules', 'SCORE_RULES', SCORING),
  ...cfgObject('moduleGrade', 'ModuleGrade', 'registerModuleGrades', 'module-grades', 'MODULE_GRADES', SCORING),
  [`GET ${BASE_ROOT}/settings`]: [
    cfgView(
      SETTINGS_OBJECT,
      'settings',
      'Settings',
      'registerSettings',
      "router.get(SETTINGS, async (c) => { const ctx = await reviewContext(c, deps, 'settings')",
    ),
  ],
  [`PATCH ${BASE_ROOT}/settings`]: cfgChange(SETTINGS_OBJECT, 'settings', 'Settings', 'registerSettings', 'update'),
  [`GET ${BASE}`]: [
    view(`router.get(PATH, async (c) => { ${VIEW}`),
    {
      perm: 'guard:talentReview.filterFieldVisible',
      facts: ['guard:talentReview.filterFieldVisible'],
      note: '带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN（字段级，只在带筛选时判定）',
      at: [
        call("if (enabled !== undefined) await requireFilterVisible(deps, ctx, 'readiness', 'enabled')"),
        {
          role: 'impl',
          unit: `${ACCESS}#requireFilterVisible`,
          anchor: "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
        },
      ],
    },
  ],
  [`GET ${BASE}/:id`]: [view(`router.get(\`\${PATH}/:id\`, async (c) => { ${VIEW}`)],
  [`POST ${BASE}`]: change('create'),
  [`PATCH ${BASE}/:id`]: [
    ...change('update'),
    {
      perm: 'guard:talentReview.renameRequiresSeeAll',
      facts: ['guard:talentReview.renameRequiresSeeAll'],
      note: '名称实际变化且不是看全部 → 403 READINESS_NAME_REQUIRES_SEE_ALL（在查重之前判定，不暴露隐藏记录）',
      at: [
        {
          role: 'call',
          unit: `${T}/readiness-service.ts#updateReadiness`,
          anchor: 'if (patch.name !== undefined && patch.name !== before.name && !ctx.scope.all) {',
        },
      ],
    },
  ],
  [`DELETE ${BASE}/:id`]: change('delete'),
};
