/**
 * 必需项表：人才评定配置（modules/evaluation/routes.ts；R3-T02 PR-B B1a 活动类型、B1b 活动周期与通用评分项）。
 * 对象操作经 access.evaluationContext → module-route-access.objectContext（对象编码 EVALUATION_OBJECTS[对象].code）；
 * 写入口另经 evaluationWriteContext 叠加按钮（BUTTON_LEVEL）。对象的增删改查由 registerObject 按 SPECS 注册
 * （路径由 spec.path 拼出，证据绑注册函数 + SPECS 常量）。写入口的写字段权（checkWriteFields）随数据操作义务承接。三类对象都是字典，没有被引用对象、所属管理单元与连带删除的子对象；被引用拒删的钩子位
 * （usage.ts）由 B4 / B5 登记引用方，登记时在各自的表项里补守卫。后续子 PR（B3～B6）在本文件追加各自对象的表项。
 */
import { NONE } from './scopes.js';
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/evaluation';
const EV = 'apps/api/src/modules/evaluation';
const ROUTES = `${EV}/routes.ts`;
const ACCESS = `${EV}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const CATALOG = 'packages/domain/src/evaluation/catalog.ts#EVALUATION_OBJECTS';

type Key = 'activityType' | 'activityCycle' | 'generalScoreItem' | 'reviewGroup' | 'evaluationForm';
/** 对象 → [编码后缀, 路径, 目录里的定义片段]。 */
const OBJECTS: Readonly<Record<Key, readonly [string, string, string]>> = {
  activityType: ['ActivityType', 'activity-types', "activityType: object('ActivityType'"],
  activityCycle: ['ActivityCycle', 'activity-cycles', "activityCycle: object('ActivityCycle'"],
  generalScoreItem: ['GeneralScoreItem', 'general-score-items', "generalScoreItem: object('GeneralScoreItem'"],
  reviewGroup: ['ReviewGroup', 'review-groups', "reviewGroup: withoutDelete(object('ReviewGroup'"],
  evaluationForm: ['EvaluationForm', 'evaluation-forms', "evaluationForm: object('EvaluationForm'"],
};
const code = (key: Key) => `TEvaluation.${OBJECTS[key][0]}`;
const objectConst = (key: Key): Evidence => ({ role: 'const', unit: CATALOG, anchor: OBJECTS[key][2] });
const call = (unit: string, anchor: string): Evidence => ({ role: 'call', unit, anchor });
const impl = (unit: string, anchor: string): Evidence => ({ role: 'impl', unit, anchor });
const specRefs = (anchor: string): Evidence => ({ role: 'const', unit: `${ROUTES}#SPECS`, anchor });

const CONTEXT: Evidence[] = [
  impl(`${ACCESS}#evaluationContext`, 'return objectContext(c, deps, codeOf(object), operation, expectedRevision)'),
  impl(
    `${MRA}#objectContext`,
    'await requirePermission(deps.authorize, { ...ctx, action: ' +
      '`object.${operation}`, resource: objectCode, fields: [] })',
  ),
];
const WRITE_CONTEXT: Evidence[] = [
  impl(
    `${ACCESS}#evaluationWriteContext`,
    'await button(deps, ctx, codeOf(object), operation, BUTTON_LEVEL[operation])',
  ),
  impl(`${MRA}#button`, "action: 'object.button', resource: buttonResource(objectCode, code, level)"),
];
const BUTTON_LEVEL: Readonly<Record<'create' | 'update' | 'delete', Evidence>> = {
  create: { role: 'const', unit: `${ACCESS}#BUTTON_LEVEL`, anchor: "create: 'list'" },
  update: { role: 'const', unit: `${ACCESS}#BUTTON_LEVEL`, anchor: "update: 'detail'" },
  delete: { role: 'const', unit: `${ACCESS}#BUTTON_LEVEL`, anchor: "delete: 'detail'" },
};
const WRITE_NOTE = '写字段权（checkWriteFields → writeFields，含显式清空）随数据操作义务承接';

function view(key: Key, entry: Evidence, more: Evidence[] = []): Obligation {
  return {
    perm: `obj:${code(key)}:view`,
    facts: ['object:objectContext'],
    at: [entry, ...more, ...CONTEXT, objectConst(key)],
  };
}
function writeOp(key: Key, operation: 'create' | 'update' | 'delete', entry: Evidence, more: Evidence[] = []) {
  return [
    {
      perm: `obj:${code(key)}:${operation}`,
      facts: ['object:objectContext'],
      at: [entry, ...more, ...CONTEXT, objectConst(key)],
      note: WRITE_NOTE,
    },
    {
      perm: `btn:${code(key)}#${operation}@${operation === 'create' ? 'list' : 'detail'}`,
      facts: ['button:button()'],
      at: [entry, ...more, ...WRITE_CONTEXT, BUTTON_LEVEL[operation], objectConst(key)],
    },
  ] satisfies Obligation[];
}

// ---- 对象的增删改查（routes.ts registerObject）-------------------------------------------------------------------
const REGISTER: Readonly<Record<'list' | 'detail' | 'create' | 'update' | 'delete', string>> = {
  list: 'router.get(path, async (c) => { const ctx = await evaluationContext(c, deps, spec.object)',
  detail: 'router.get(`${path}/:id`, async (c) => { const ctx = await evaluationContext(c, deps, spec.object)',
  create: "router.post(path, async (c) => { const ctx = await evaluationWriteContext(c, deps, spec.object, 'create'",
  update:
    'router.patch(`${path}/:id`, async (c) => { const ctx = await evaluationWriteContext(c, deps, spec.object, ' +
    "'update'",
  delete:
    'router.delete(`${path}/:id`, async (c) => { const ctx = await evaluationWriteContext(c, deps, spec.object, ' +
    "'delete'",
};
// 评审组单独成文件（review-group-routes.ts）：不进通用注册器，通用接口的权限事实里不会多出员工信息查看权
const OWN_FILE = {
  reviewGroup: { file: `${EV}/review-group-routes.ts`, register: 'registerReviewGroupRoutes', path: 'review-groups' },
  evaluationForm: { file: `${EV}/form-routes.ts`, register: 'registerFormRoutes', path: 'evaluation-forms' },
} as const;
type OwnKey = keyof typeof OWN_FILE;
const isOwn = (key: Key): key is OwnKey => key in OWN_FILE;
const GROUP_REGISTER: Readonly<Record<keyof typeof REGISTER, string>> = {
  list: 'router.get(PATH, async (c) => { const ctx = await evaluationContext(c, deps, OBJECT)',
  detail: 'router.get(`${PATH}/:id`, async (c) => { const ctx = await evaluationContext(c, deps, OBJECT)',
  create: "router.post(PATH, async (c) => { const ctx = await evaluationWriteContext(c, deps, OBJECT, 'create'",
  update:
    "router.patch(`${PATH}/:id`, async (c) => { const ctx = await evaluationWriteContext(c, deps, OBJECT, 'update'",
  delete:
    "router.delete(`${PATH}/:id`, async (c) => { const ctx = await evaluationWriteContext(c, deps, OBJECT, 'delete'",
};
const registered = (entry: keyof typeof REGISTER, key: Key = 'activityType') =>
  isOwn(key)
    ? call(`${OWN_FILE[key].file}#${OWN_FILE[key].register}`, GROUP_REGISTER[entry])
    : call(
        `${ROUTES}#${entry === 'list' || entry === 'detail' ? 'registerObject' : 'registerWrites'}`,
        REGISTER[entry],
      );
const spec = (key: Key): Evidence[] =>
  isOwn(key)
    ? [
        { role: 'const', unit: `${OWN_FILE[key].file}#PATH`, anchor: `\`\${EV_BASE}/${OWN_FILE[key].path}\`` },
        call(`${ROUTES}#registerEvaluationRoutes`, `${OWN_FILE[key].register}(router, deps);`),
      ]
    : specOf(key);
const specOf = (key: Key): Evidence[] => [
  specRefs(`${key}: { object: '${key}', path: '${OBJECTS[key][1]}'`),
  call(
    `${ROUTES}#registerEvaluationRoutes`,
    'for (const spec of Object.values(SPECS)) registerObject(router, deps, spec as ObjectRoutes<object, object>)',
  ),
];

/** 列表筛选字段须有查看权（字段级，只在带筛选参数时判定）。 */
const filterFieldVisible = (key: Key): Obligation => ({
  perm: 'guard:ev.filterFieldVisible',
  facts: ['guard:ev.filterFieldVisible'],
  note: '带 enabled 筛选而无 enabled 字段查看权 → 403 FILTER_FIELD_HIDDEN；排序键只取可见字段（read-model.orderBy）',
  at: [
    isOwn(key)
      ? call(
          `${OWN_FILE[key].file}#${OWN_FILE[key].register}`,
          "if (enabled !== undefined) requireFilterVisible(fields, 'enabled')",
        )
      : call(`${ROUTES}#registerObject`, 'requireFilterVisible(fields, field)'),
    impl(
      `${ACCESS}#requireFilterVisible`,
      "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
    ),
    ...(isOwn(key) ? spec(key) : [specRefs(`${key}: { object: '${key}', path: '${OBJECTS[key][1]}'`)]),
  ],
});

// ---- 评审组（B3）：所属组织、人员引用出口、成员候选 -------------------------------------------------------------------
const PERSONS = `${EV}/person-refs.ts`;
const GROUP_SERVICE = `${EV}/review-group-service.ts`;
const PERSONNEL = 'TenantBase.EmployeeInformation';
const PERSONNEL_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
  anchor: "PERSONNEL_OBJECT = 'TenantBase.EmployeeInformation'",
};
const PERSON_VIEW_CALL = call(
  `${PERSONS}#personRefAccess`,
  "const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: PERSONNEL_OBJECT, fields: [] })",
);

/** 每个评审组出口都带成员：员工信息的姓名 / 工号按查看权与人员范围披露（范围外只有姓名），不是准入。 */
const memberRefs: Obligation = {
  perm: `obj:${PERSONNEL}:view`,
  purpose: 'disclosure:memberRefs',
  facts: ['object:object.* 动作'],
  note: '成员的姓名 / 工号按员工信息查看权与字段权、人员范围披露（DEC-331① / DEC-339②）；范围外成员只有姓名',
  need: { scope: 'list', predicate: 'ev.personScope' },
  at: [
    call(`${GROUP_SERVICE}#presentGroups`, 'const refs = await presentPersonRefs('),
    impl(`${PERSONS}#presentPersonRefs`, 'if (!ids.length || !access.scope) return result;'),
    PERSON_VIEW_CALL,
    PERSONNEL_CONST,
    {
      role: 'scope',
      unit: `${PERSONS}#employeesInScope`,
      anchor: 'const inScope = scopeSql(scope, { person: sql`e.id` });',
    },
  ],
};
/** 写入口的成员呈现：员工信息的访问在命令事务内解析（personRefAccessInTransaction），探测器不再观测到读路径的授权调用。 */
const { facts: _readFacts, ...memberRefsBase } = memberRefs;
const memberRefsWrite: Obligation = memberRefsBase;

/** 新增的成员须存在且在人员范围内（范围外与不存在同一 404）；没有员工信息查看权 403。 */
function newPersonRefs(entry: Evidence): Obligation[] {
  return [
    {
      perm: 'guard:ev.newPersonRefs',
      note: '只校验本次新增的员工 ID；集合里原有的范围外 ID 原样保留（DEC-319① 同口径）',
      at: [
        entry,
        impl(
          PERSONS + '#assertNewPersonRefs',
          "if (!access.scope) throw new AppError('FORBIDDEN', '无权查看员工信息', { reason: 'NO_EMPLOYEE_ACCESS' })",
        ),
      ],
    },
    {
      perm: `obj:${PERSONNEL}:view`,
      purpose: 'guard:ev.newPersonRefs',
      inner: { role: 'required' },
      at: [PERSON_VIEW_CALL, PERSONNEL_CONST],
    },
  ];
}

const ownerOrgInScope: Obligation = {
  perm: 'guard:ev.ownerOrgInScope',
  note: '改所属组织时新组织须存在且在范围内（范围外与不存在同一 404，DEC-082）',
  at: [
    call(`${GROUP_SERVICE}#updateReviewGroup`, 'await requireOwnerOrg(tx, ctx, body.ownerOrgId);'),
    impl(`${EV}/store.ts#requireOwnerOrg`, "throw new AppError('NOT_FOUND', '所属组织不存在')"),
  ],
};

function reviewGroupCrud(): RequiredTable {
  const key: Key = 'reviewGroup';
  const path = `${BASE}/${OBJECTS[key][1]}`;
  const op = (operation: 'create' | 'update' | 'delete') =>
    writeOp(key, operation, registered(operation, key), spec(key));
  return {
    [`GET ${path}`]: [view(key, registered('list', key), spec(key)), filterFieldVisible(key), memberRefs],
    [`GET ${path}/:id`]: [view(key, registered('detail', key), spec(key)), memberRefs],
    [`POST ${path}`]: [
      ...op('create'),
      ...newPersonRefs(call(`${GROUP_SERVICE}#createReviewGroup`, 'await assertNewPersonRefs(')),
      memberRefsWrite,
    ],
    [`PATCH ${path}/:id`]: [
      ...op('update'),
      ...newPersonRefs(call(`${GROUP_SERVICE}#updateReviewGroup`, 'await assertNewPersonRefs(')),
      ownerOrgInScope,
      memberRefsWrite,
    ],
  };
}

// ---- 评价表（B4）：所属组织、评分项引用（通用评分项 / 隐藏指标）----------------------------------------------------------
const FORM_REFS = `${EV}/form-refs.ts`;
const FORM_SERVICE = `${EV}/form-service.ts`;
const GENERAL_CODE = 'TEvaluation.GeneralScoreItem';
const TARGET_CODE = 'Qualification.Target';
const GENERAL_CONST: Evidence = { role: 'const', unit: CATALOG, anchor: "generalScoreItem: object('GeneralScoreItem'" };
const TARGET_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/qualification/catalog.ts#QUALIFICATION_OBJECTS',
  anchor: "target: owned('Target'",
};
const NAMES_CALL = call(`${FORM_SERVICE}#presentForms`, 'const names = await referenceNames(');
const CAN_VIEW = impl(
  `${FORM_REFS}#hasObjectView`,
  "authorize({ ...ctx, action: 'object.view', resource, fields: [] })",
);
/** 写命令里引用访问的事务内解析点（route-support 的 before 经 WriteRefs.resolve 调到这里）。 */
const RESOLVE_REFS = call(
  `${FORM_REFS}#resolveFormRefs`,
  'return { general: await one(GENERAL), target: await one(TARGET) };',
);

/** 每个评价表出口都带评分项：通用评分项名称按字典查看权 + 范围 + 名称字段权披露，不是准入（设计 §5.2 #6）。 */
const generalItemRefs: Obligation = {
  perm: `obj:${GENERAL_CODE}:view`,
  purpose: 'disclosure:generalItemRefs',
  facts: ['object:object.* 动作'],
  note: '通用评分项名称按字典查看权、范围与名称字段权披露，看不到只给 ID',
  need: { scope: 'list', predicate: 'ev.dictionary' },
  at: [
    NAMES_CALL,
    impl(`${FORM_REFS}#referenceNames`, "if (shows(access.general, 'name') && ids.generalItemIds.length) {"),
    CAN_VIEW,
    GENERAL_CONST,
    {
      role: 'scope',
      unit: `${FORM_REFS}#referenceNames`,
      anchor: "const readable = scopePredicate(access.general.scope, 'generalScoreItem', 'g');",
    },
  ],
};
/** 隐藏指标名称：指标只放开查看（DEC-352），按对象查看权 + 名称字段权披露，不按范围过滤。 */
const targetRefs: Obligation = {
  perm: `obj:${TARGET_CODE}:view`,
  purpose: 'disclosure:targetRefs',
  note: '隐藏指标名称按指标查看权与名称字段权披露，看不到只给 ID',
  need: NONE,
  at: [
    NAMES_CALL,
    impl(`${FORM_REFS}#referenceNames`, "if (shows(access.target, 'name') && ids.targetIds.length) {"),
    CAN_VIEW,
    TARGET_CONST,
  ],
};
const formRefs = [generalItemRefs, targetRefs];
/** 写入口的引用呈现：访问在命令事务内解析（resolveFormRefs），探测器不再观测到读路径的授权调用。 */
const { facts: _formReadFacts, ...generalItemRefsBase } = generalItemRefs;
const formRefsWrite: Obligation[] = [generalItemRefsBase, targetRefs];

/** 新增的引用须有对象查看权、存在且在范围内（范围外与不存在同一 404）、已启用；原有引用原样保留。 */
function newFormRefs(entry: Evidence): Obligation[] {
  return [
    {
      perm: 'guard:ev.newFormRefs',
      note: '只校验本次新增的通用评分项 / 隐藏指标 ID；原有引用不重校（DEC-281⑧ 同口径）',
      at: [
        entry,
        impl(
          `${FORM_REFS}#assertNewFormRefs`,
          "throw new AppError('FORBIDDEN', '无权查看通用评分项', { reason: 'NO_GENERAL_ITEM_ACCESS' })",
        ),
      ],
    },
    {
      perm: `obj:${GENERAL_CODE}:view`,
      purpose: 'guard:ev.newFormRefs',
      inner: { role: 'required' },
      at: [RESOLVE_REFS, CAN_VIEW, GENERAL_CONST],
    },
    {
      perm: `obj:${TARGET_CODE}:view`,
      purpose: 'guard:ev.newFormRefs',
      inner: { role: 'required' },
      at: [RESOLVE_REFS, CAN_VIEW, TARGET_CONST],
    },
  ];
}

const formOwnerOrgInScope: Obligation = {
  perm: 'guard:ev.ownerOrgInScope',
  note: '改所属组织时新组织须存在且在范围内（范围外与不存在同一 404，DEC-082）',
  at: [
    call(`${FORM_SERVICE}#updateForm`, 'await requireOwnerOrg(tx, ctx, body.ownerOrgId);'),
    impl(`${EV}/store.ts#requireOwnerOrg`, "throw new AppError('NOT_FOUND', '所属组织不存在')"),
  ],
};

function formCrud(): RequiredTable {
  const key: Key = 'evaluationForm';
  const path = `${BASE}/${OBJECTS[key][1]}`;
  const op = (operation: 'create' | 'update' | 'delete') =>
    writeOp(key, operation, registered(operation, key), spec(key));
  return {
    [`GET ${path}`]: [view(key, registered('list', key), spec(key)), filterFieldVisible(key), ...formRefs],
    [`GET ${path}/:id`]: [view(key, registered('detail', key), spec(key)), ...formRefs],
    [`POST ${path}`]: [
      ...op('create'),
      ...newFormRefs(call(`${FORM_SERVICE}#createForm`, 'await assertNewFormRefs(')),
      ...formRefsWrite,
    ],
    [`PATCH ${path}/:id`]: [
      ...op('update'),
      ...newFormRefs(call(`${FORM_SERVICE}#updateForm`, 'await assertNewFormRefs(')),
      formOwnerOrgInScope,
      ...formRefsWrite,
    ],
    [`DELETE ${path}/:id`]: [...op('delete'), ...formRefsWrite],
  };
}

/** 评审组成员候选：员工信息查看权 + 人员范围（分页前），字段按员工信息字段权，关键字只匹配可见字段。 */
const CANDIDATES = `${EV}/candidates.ts`;
const CANDIDATE_ROUTE = `${CANDIDATES}#registerCandidates`;
const candidates: RequiredTable = {
  [`GET ${BASE}/candidates/review-members`]: [
    {
      perm: `obj:${PERSONNEL}:view`,
      facts: ['object:objectContext', `objectOp:${PERSONNEL}:view`],
      at: [
        call(CANDIDATE_ROUTE, "const ctx = await objectContext(c, deps, PERSONNEL_OBJECT, 'view')"),
        ...CONTEXT.slice(1),
        PERSONNEL_CONST,
      ],
    },
    {
      perm: 'guard:ev.filterFieldVisible',
      facts: ['guard:ev.filterFieldVisible'],
      note: '带关键字而姓名 / 工号字段都没有查看权 → 403 FILTER_FIELD_HIDDEN（只匹配看得到的字段）',
      at: [
        call(CANDIDATE_ROUTE, "if (keyword && !matches.length) requireFilterVisible(fields, 'name');"),
        impl(
          `${ACCESS}#requireFilterVisible`,
          "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
        ),
      ],
    },
  ],
};

// ---- 通用评分项停用 / 删除：被评价表引用时只列操作人看得到的评价表（B4，DEC-374⑥）----------------------------------------
const FORM_CODE = 'TEvaluation.EvaluationForm';
/** 引用方评价表的可见范围：评价表查看权 + 所属组织 ∪ 所属人范围，在命令事务内解析；只决定提示里列哪些名称，不是准入。 */
const referrers: Obligation = {
  perm: `obj:${FORM_CODE}:view`,
  purpose: 'disclosure:referrers',
  note: '停用被引用的通用评分项时，提示只列操作人看得到的评价表，其余计入“其他 N 个”（DEC-374⑥）',
  need: { scope: 'list', predicate: 'ev.owned(ev_forms)' },
  at: [
    call(`${ROUTES}#registerWrites`, 'spec.refs'),
    call(`${FORM_REFS}#resolveFormVisibility`, 'canView: await hasObjectView(bound.authorize, ctx, FORM),'),
    CAN_VIEW,
    { role: 'const', unit: CATALOG, anchor: "evaluationForm: object('EvaluationForm'" },
    {
      role: 'scope',
      unit: `${EV}/form-usage.ts#registerFormUsage`,
      anchor: "ctx.formVisibility?.canView === true ? scopePredicate(ctx.formVisibility.scope, 'evaluationForm', 'f')",
    },
  ],
};

function crud(key: Key): RequiredTable {
  const path = `${BASE}/${OBJECTS[key][1]}`;
  const op = (operation: 'create' | 'update' | 'delete') => writeOp(key, operation, registered(operation), spec(key));
  return {
    [`GET ${path}`]: [view(key, registered('list'), spec(key)), filterFieldVisible(key)],
    [`GET ${path}/:id`]: [view(key, registered('detail'), spec(key))],
    [`POST ${path}`]: op('create'),
    [`PATCH ${path}/:id`]: key === 'generalScoreItem' ? [...op('update'), referrers] : op('update'),
    [`DELETE ${path}/:id`]: key === 'generalScoreItem' ? [...op('delete'), referrers] : op('delete'),
  };
}

export const EVALUATION: RequiredTable = {
  ...crud('activityType'),
  ...crud('activityCycle'),
  ...crud('generalScoreItem'),
  ...reviewGroupCrud(),
  ...formCrud(),
  ...candidates,
};
