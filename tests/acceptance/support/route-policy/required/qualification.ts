/**
 * 必需项表：任职资格配置（modules/qualification/routes.ts、extras.ts、candidates.ts；R3-T02 PR-A）。
 * 对象操作经 access.qualificationContext → module-route-access.objectContext（对象编码 QUALIFICATION_OBJECTS[对象].code）；
 * 写入口另经 qualificationWriteContext 叠加按钮（BUTTON_LEVEL）。八类对象的增删改查由 registerObject 按 SPECS 注册
 * （路径由 spec.path 拼出，证据绑注册函数 + SPECS 常量）。被引用对象经 writeContext 解析查看权（为假 → 范围 null）
 * → store.referenced 抛 403；新建带资源集合的对象经 store.ownerOf → owner-units.chooseUnit 选授权管理单元（DEC-339）。
 * 查看只放开（DEC-352）不改变准入义务：读取仍要对象查看权，范围谓词是元数据；写入仍按管理单元（DEC-355① / D-065）。
 * 写入口的 `object.* 动作` 事实是写字段权（checkWriteFields）与被引用对象 / 岗职务的查看权（writeContext），随数据
 * 操作义务承接；查看口的同一事实是投影里按源对象查看权逐节点裁剪（不拒绝），随查看义务承接。
 */
import { list, SCOPE_AT } from './scopes.js';
import type { Evidence, Inner, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/qualification';
const QL = 'apps/api/src/modules/qualification';
const ROUTES = `${QL}/routes.ts`;
const EXTRAS = `${QL}/extras.ts`;
const ACCESS = `${QL}/access.ts`;
const STORE = `${QL}/store.ts`;
const SUPPORT = `${QL}/route-support.ts`;
const CONFIG = `${QL}/config-service.ts`;
const TARGETS = `${QL}/target-service.ts`;
const STANDARDS = `${QL}/standard-service.ts`;
const CANDIDATES = `${QL}/candidates.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const CATALOG = 'packages/domain/src/qualification/catalog.ts#QUALIFICATION_OBJECTS';

type Key = 'categoryClass' | 'category' | 'layer' | 'level' | 'targetType' | 'target' | 'gradeScheme' | 'standard';
type Ref = Key | 'codingRule' | 'developmentChannel' | 'targetGradeDescription';
/** 对象 → [编码后缀, 路径, 目录里的定义片段]。 */
const OBJECTS: Readonly<Record<Ref, readonly [string, string, string]>> = {
  categoryClass: [
    'EmploymentCategoryClassify',
    'category-classes',
    "categoryClass: owned( 'EmploymentCategoryClassify'",
  ],
  category: ['EmploymentCategory', 'categories', "category: owned('EmploymentCategory'"],
  layer: ['Level', 'layers', "layer: object('Level'"],
  level: ['EmploymentLevel', 'levels', "level: owned('EmploymentLevel'"],
  targetType: ['TargetType', 'target-types', "targetType: owned('TargetType'"],
  target: ['Target', 'targets', "target: owned('Target'"],
  gradeScheme: ['GradeScheme', 'grade-schemes', "gradeScheme: object('GradeScheme'"],
  standard: ['QualificationStandard', 'standards', "standard: object( 'QualificationStandard'"],
  codingRule: ['CodingRule', '', "codingRule: object( 'CodingRule'"],
  developmentChannel: ['DevelopmentChannel', '', "developmentChannel: object('DevelopmentChannel'"],
  targetGradeDescription: ['TargetGradeDescription', '', "targetGradeDescription: object('TargetGradeDescription'"],
};
const code = (key: Ref) => `Qualification.${OBJECTS[key][0]}`;
const objectConst = (key: Ref): Evidence => ({ role: 'const', unit: CATALOG, anchor: OBJECTS[key][2] });
const call = (unit: string, anchor: string): Evidence => ({ role: 'call', unit, anchor });
const impl = (unit: string, anchor: string): Evidence => ({ role: 'impl', unit, anchor });

const CONTEXT: Evidence[] = [
  impl(`${ACCESS}#qualificationContext`, 'return objectContext(c, deps, codeOf(object), operation, expectedRevision)'),
  impl(
    `${MRA}#objectContext`,
    'await requirePermission(deps.authorize, { ...ctx, action: ' +
      '`object.${operation}`, resource: objectCode, fields: [] })',
  ),
];
const WRITE_CONTEXT: Evidence[] = [
  impl(
    `${ACCESS}#qualificationWriteContext`,
    'await button(deps, ctx, codeOf(object), operation, BUTTON_LEVEL[operation])',
  ),
  impl(`${MRA}#button`, "action: 'object.button', resource: buttonResource(objectCode, code, level)"),
];
const BUTTON_LEVEL: Readonly<Record<'create' | 'update' | 'delete', Evidence>> = {
  create: { role: 'const', unit: `${ACCESS}#BUTTON_LEVEL`, anchor: "create: 'list'" },
  update: { role: 'const', unit: `${ACCESS}#BUTTON_LEVEL`, anchor: "update: 'detail'" },
  delete: { role: 'const', unit: `${ACCESS}#BUTTON_LEVEL`, anchor: "delete: 'detail'" },
};
const WRITE_NOTE = 'object.* 动作：写字段权（checkWriteFields）与被引用对象 / 岗职务的查看权（writeContext）';
const PROJECTION_NOTE = 'object.* 动作：投影里按源对象的查看权与字段权逐节点裁剪，不拒绝（DEC-309）';

/** 查看义务；`projection` = 本端点另观测到投影里的 `object.* 动作`，`more` = 决定实参的注册常量。 */
function view(key: Ref, entry: Evidence, projection = false, more: Evidence[] = []): Obligation {
  return {
    perm: `obj:${code(key)}:view`,
    facts: ['object:objectContext', ...(projection ? ['object:object.* 动作'] : [])],
    at: [entry, ...more, ...CONTEXT, objectConst(key)],
    ...(projection ? { note: PROJECTION_NOTE } : {}),
  };
}
function writeOp(key: Ref, operation: 'create' | 'update' | 'delete', entry: Evidence, more: Evidence[] = []) {
  return [
    {
      perm: `obj:${code(key)}:${operation}`,
      facts: ['object:objectContext', 'object:object.* 动作'],
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

// ---- 被引用对象、所属管理单元、岗职务关联、连带删除 -----------------------------------------------------------------
const REFERENCED_IMPL = impl(
  `${STORE}#referenced`,
  "if (scope === null) throw new AppError('FORBIDDEN', `无权查看${label}`)",
);
const REFERENCE_VIEW = call(
  `${SUPPORT}#writeContext`,
  "const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(ref), fields: [] })",
);
/** 被引用对象：查看权为假 → 范围 null → referenced 抛 403；查看权是守卫内部义务。`declared` 决定实参的常量 / 调用。 */
function referenced(target: Ref, calls: readonly Evidence[], declared: Evidence, inner: Inner): Obligation[] {
  const carrier = `ql.referenced(${target})`;
  return [
    { perm: `guard:${carrier}`, at: [...calls, REFERENCED_IMPL, declared] },
    {
      perm: `obj:${code(target)}:view`,
      purpose: `guard:${carrier}`,
      inner,
      at: [REFERENCE_VIEW, declared, objectConst(target)],
    },
  ];
}
const specRefs = (anchor: string): Evidence => ({ role: 'const', unit: `${ROUTES}#SPECS`, anchor });

const CHOOSE_UNIT = impl(
  'apps/api/src/modules/permission/owner-units.ts#chooseUnit',
  'if (!units.length) throw noUnit()',
);
const ownerUnit = (key: Ref, unit: string, anchor: string): Obligation => ({
  perm: `guard:ql.ownerUnit(${key})`,
  note: '资源集合 = 创建人在 Qualification 的授权管理单元：没有 403、多个须显式选、选了别人的 404（DEC-339）',
  at: [
    call(unit, anchor),
    impl(`${STORE}#ownerOf`, 'const orgId = await chooseUnit(tx, ctx, QUALIFICATION_APP, requested)'),
    impl(`${STORE}#ownerOf`, 'visible(ctx.scope, orgId, `${QUALIFICATION_LABELS[object]}不存在`)'),
    CHOOSE_UNIT,
  ],
});

const jobLinks = (key: 'category' | 'level', declared: Evidence): Obligation => ({
  perm: `guard:ql.jobLinks(${key})`,
  note: '关联的岗职务须有对象查看权且在职务应用的读取范围内（writeContext 解析 jobs，查看权为假 → null → 403）',
  at: [
    call(`${CONFIG}#replaceJobLinks`, 'const { item, fields, label } = await jobObject(tx, ctx, linkType!, jobId)'),
    impl(`${CONFIG}#jobObject`, "if (access === null) throw new AppError('FORBIDDEN', `无权查看${meta.label}`)"),
    impl(
      `${SUPPORT}#writeContext`,
      "const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] })",
    ),
    declared,
  ],
});
const JOB_LINKS_DERIVED: Obligation = {
  perm: 'guard:ql.jobLinksDerived',
  note: '改关联类型派生出清空关联时同样要 jobLinks 编辑权（第 2 轮 P2-04）',
  at: [
    call(
      `${CONFIG}#patchJobLinks`,
      'if (body.jobLinks === undefined && links.length !== kept.length && ctx.jobLinksEditable !== true) {',
    ),
    call(
      `${ROUTES}#registerObject`,
      "...(spec.jobs ? { jobLinksEditable: await fieldEditable(deps, ctx, spec.object, 'jobLinks') } : {})",
    ),
    impl(`${SUPPORT}#fieldEditable`, "await writeFields(deps, ctx, codeOf(object), 'update', { [field]: null })"),
  ],
};

const CHILD_DELETES_ROUTE = call(`${ROUTES}#registerObject`, 'childDeletes: await childDeleteRights(deps, ctx, spec)');
function childDeletes(child: Ref, unit: string, children: Evidence, inner: Inner): Obligation[] {
  const carrier = `ql.childDeletes(${child})`;
  return [
    {
      perm: `guard:${carrier}`,
      note: '确有连带删除的子对象时才要求子对象的删除权（DEC-338 自检），逐条写删除快照',
      at: [
        call(unit, `await deleteChildren( tx, ctx, '${child}',`),
        impl(`${STORE}#deleteChildren`, 'if (!ctx.childDeletes?.[child]) {'),
        children,
      ],
    },
    {
      perm: `obj:${code(child)}:delete`,
      purpose: `guard:${carrier}`,
      inner,
      at: [
        CHILD_DELETES_ROUTE,
        impl(
          `${ROUTES}#childDeleteRights`,
          'result[child] = await deps.authorize({ ...ctx, ' +
            "action: 'object.delete', resource: codeOf(child), fields: [] })",
        ),
        children,
        objectConst(child),
      ],
    },
  ];
}
const CHILD_SCOPE: Obligation = {
  perm: 'guard:ql.childScope(target)',
  note: '等级方案连带删除的遗留描述随指标授权：所属指标须都在写范围内，否则整体 403 CHILD_OUT_OF_SCOPE（第 3 轮 R2-06）',
  at: [
    call(
      `${TARGETS}#deleteGradeScheme`,
      'await requireTargetsEditable( tx, ctx, leftovers.map((item) => item.targetId), )',
    ),
    impl(
      `${TARGETS}#requireTargetsEditable`,
      "throw new AppError('FORBIDDEN', '等级方案上有不在你管理范围内的指标手改描述，不能删除', {",
    ),
    specRefs("deleteScopes: ['target']"),
  ],
};

/** 标准里通用指标覆盖写入的能力标准：指标查看权 / 字段权不通过只省略内容（projectionHidden），不拒绝。 */
const OVERWRITTEN_CONTENT: Obligation = {
  perm: `obj:${code('target')}:view`,
  purpose: 'disclosure:overwrittenContent',
  need: list('ql.openRead(ql_targets)'),
  at: [
    call(
      `${SUPPORT}#presenter`,
      'const shaped = await hideOverwritten(c, deps, ctx, items as unknown as read.StandardView[])',
    ),
    impl(
      `${SUPPORT}#hideOverwritten`,
      "const readable = visible ? await readableIds(c, deps, ctx, 'target', sources) : new Set<string>()",
    ),
    impl(
      `${SUPPORT}#readableIds`,
      "if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(object), fields: [] }))) {",
    ),
    objectConst('target'),
    ...SCOPE_AT['ql.openRead(ql_targets)'],
  ],
};

// ---- 八类对象的增删改查（routes.ts registerObject）-------------------------------------------------------------------
const REGISTER: Readonly<Record<'list' | 'detail' | 'create' | 'update' | 'delete', string>> = {
  list: 'router.get(path, async (c) => { const ctx = await qualificationContext(c, deps, spec.object)',
  detail: 'router.get(`${path}/:id`, async (c) => { const ctx = await qualificationContext(c, deps, spec.object)',
  create: "router.post(path, async (c) => { const ctx = await qualificationWriteContext(c, deps, spec.object, 'create'",
  update:
    'router.patch(`${path}/:id`, async (c) => { const ctx = await qualificationWriteContext(c, deps, spec.object, ' +
    "'update'",
  delete:
    'router.delete(`${path}/:id`, async (c) => { const ctx = await qualificationWriteContext(c, deps, spec.object, ' +
    "'delete'",
};
const registered = (entry: keyof typeof REGISTER) => call(`${ROUTES}#registerObject`, REGISTER[entry]);
const spec = (key: Key): Evidence[] => [
  specRefs(`${key}: { object: '${key}', path: '${OBJECTS[key][1]}'`),
  call(
    `${ROUTES}#registerQualificationRoutes`,
    'for (const spec of Object.values(SPECS)) registerObject(router, deps, spec as ObjectRoutes<object, object>)',
  ),
];

function createGuards(key: Key): Obligation[] {
  const svc = (unit: string, anchor: string) => call(unit, anchor);
  switch (key) {
    case 'categoryClass':
      return [
        ownerUnit(
          key,
          `${CONFIG}#createCategoryClass`,
          "const owner = await ownerOf(tx, ctx, 'categoryClass', body.ownerOrgId)",
        ),
        ...referenced(
          'categoryClass',
          [
            svc(
              `${CONFIG}#createCategoryClass`,
              "const parent = await referenced(tx, ctx, 'categoryClass', body.parentId)",
            ),
          ],
          specRefs("patchSchema: input.categoryClassPatch, references: ['categoryClass']"),
          { role: 'when', condition: 'body.parentId' },
        ),
      ];
    case 'category':
      return [
        ownerUnit(key, `${CONFIG}#insertCategory`, "const owner = await ownerOf(tx, ctx, 'category', body.ownerOrgId)"),
        ...referenced(
          'categoryClass',
          [svc(`${CONFIG}#createCategory`, "await referenced(tx, ctx, 'categoryClass', body.classId)")],
          specRefs("patchSchema: input.categoryPatch, references: ['categoryClass']"),
          { role: 'required' },
        ),
        jobLinks('category', specRefs('jobs: CATEGORY_JOBS')),
      ];
    case 'level':
      return [
        ownerUnit(key, `${CONFIG}#insertLevel`, "const owner = await ownerOf(tx, ctx, 'level', body.ownerOrgId)"),
        ...referenced(
          'layer',
          [svc(`${CONFIG}#insertLevel`, "if (body.layerId) await referenced(tx, ctx, 'layer', body.layerId)")],
          specRefs("references: ['layer']"),
          { role: 'when', condition: 'body.layerId' },
        ),
        jobLinks('level', specRefs('jobs: LEVEL_JOBS')),
      ];
    case 'targetType':
      return [
        ownerUnit(
          key,
          `${CONFIG}#createTargetType`,
          "const owner = await ownerOf(tx, ctx, 'targetType', body.ownerOrgId)",
        ),
        ...referenced(
          'targetType',
          [
            svc(
              `${CONFIG}#createTargetType`,
              "if (body.parentId) await referenced(tx, ctx, 'targetType', body.parentId)",
            ),
          ],
          specRefs("references: ['targetType']"),
          { role: 'when', condition: 'body.parentId' },
        ),
      ];
    case 'target':
      return [
        ownerUnit(key, `${TARGETS}#createTarget`, "const owner = await ownerOf(tx, ctx, 'target', body.ownerOrgId)"),
        ...referenced(
          'targetType',
          [svc(`${TARGETS}#createTarget`, "await referenced(tx, ctx, 'targetType', body.typeId)")],
          specRefs("references: ['targetType', 'gradeScheme']"),
          { role: 'required' },
        ),
        ...referenced(
          'gradeScheme',
          [GRADE_SCHEME_CHECK, CREATE_EVAL_MODE],
          specRefs("references: ['targetType', 'gradeScheme']"),
          { role: 'when', condition: 'evalMode=grade' },
        ),
      ];
    case 'standard':
      return [
        ...referenced(
          'level',
          [
            svc(
              `${STANDARDS}#createStandard`,
              "for (const levelId of levelIds) await referenced(tx, ctx, 'level', levelId)",
            ),
          ],
          specRefs("references: ['category', 'level', 'target']"),
          { role: 'required' },
        ),
        ...referenced(
          'target',
          [
            CELL_TARGET,
            svc(`${STANDARDS}#createStandard`, 'await writeCells(tx, ctx, id, levelIds, body.details, [])'),
          ],
          specRefs("references: ['category', 'level', 'target']"),
          { role: 'when', condition: 'body.details' },
        ),
      ];
    default:
      return [];
  }
}
const GRADE_SCHEME_CHECK = call(`${TARGETS}#checkEvalMode`, "await referenced(tx, ctx, 'gradeScheme', schemeId)");
const CREATE_EVAL_MODE = call(
  `${TARGETS}#createTarget`,
  'await checkEvalMode(tx, ctx, body.evalMode, body.gradeSchemeId)',
);
const CELL_TARGET = call(
  `${STANDARDS}#writeCells`,
  "const target = (await referenced( tx, ctx, 'target', cell.targetId,",
);

function updateGuards(key: Key): Obligation[] {
  switch (key) {
    case 'category':
      return [
        jobLinks('category', specRefs('jobs: CATEGORY_JOBS')),
        {
          ...JOB_LINKS_DERIVED,
          at: [
            ...JOB_LINKS_DERIVED.at,
            call(
              `${CONFIG}#updateCategory`,
              "await patchJobLinks(tx, ctx, 'category', id, row, before as JobLinked, body)",
            ),
          ],
        },
      ];
    case 'level':
      return [
        ...referenced(
          'layer',
          [
            call(
              `${CONFIG}#updateLevel`,
              "if (body.layerId && body.layerId !== current.layer_id) await referenced(tx, ctx, 'layer', body.layerId)",
            ),
          ],
          specRefs("references: ['layer']"),
          { role: 'when', condition: 'layerChanged' },
        ),
        jobLinks('level', specRefs('jobs: LEVEL_JOBS')),
        {
          ...JOB_LINKS_DERIVED,
          at: [
            ...JOB_LINKS_DERIVED.at,
            call(`${CONFIG}#updateLevel`, "await patchJobLinks(tx, ctx, 'level', id, row, before as JobLinked, body)"),
          ],
        },
      ];
    case 'target':
      return [
        ...referenced(
          'gradeScheme',
          [GRADE_SCHEME_CHECK, call(`${TARGETS}#updateTarget`, 'await checkEvalMode(tx, ctx, mode, scheme)')],
          specRefs("references: ['targetType', 'gradeScheme']"),
          { role: 'when', condition: 'evalMode=grade' },
        ),
      ];
    case 'standard':
      return [
        ...referenced(
          'target',
          [
            CELL_TARGET,
            call(
              `${STANDARDS}#updateStandard`,
              'if (body.details) await writeCells(tx, ctx, id, before.levelIds, body.details, before.details)',
            ),
          ],
          specRefs("references: ['category', 'level', 'target']"),
          { role: 'when', condition: 'body.details' },
        ),
      ];
    default:
      return [];
  }
}

function deleteGuards(key: Key): Obligation[] {
  const children = (anchor: string) => specRefs(anchor);
  switch (key) {
    case 'target':
      return childDeletes(
        'targetGradeDescription',
        `${TARGETS}#deleteTarget`,
        children("children: ['targetGradeDescription'], filter:"),
        { role: 'when', condition: 'childrenExist' },
      );
    case 'gradeScheme':
      return [
        CHILD_SCOPE,
        ...childDeletes(
          'targetGradeDescription',
          `${TARGETS}#deleteGradeScheme`,
          children("children: ['targetGradeDescription'], deleteScopes: ['target']"),
          { role: 'when', condition: 'childrenExist' },
        ),
      ];
    case 'standard':
      return childDeletes(
        'developmentChannel',
        `${STANDARDS}#deleteStandard`,
        children("children: ['developmentChannel']"),
        { role: 'when', condition: 'childrenExist' },
      );
    default:
      return [];
  }
}

function crud(key: Key): RequiredTable {
  const path = `${BASE}/${OBJECTS[key][1]}`;
  const nested = key === 'standard' ? [OVERWRITTEN_CONTENT] : [];
  const op = (operation: 'create' | 'update' | 'delete', entry: keyof typeof REGISTER) =>
    writeOp(key, operation, registered(entry), spec(key));
  return {
    [`GET ${path}`]: [view(key, registered('list'), false, spec(key)), ...nested],
    [`GET ${path}/:id`]: [view(key, registered('detail'), false, spec(key)), ...nested],
    [`POST ${path}`]: [...op('create', 'create'), ...createGuards(key), ...nested],
    [`PATCH ${path}/:id`]: [...op('update', 'update'), ...updateGuards(key), ...nested],
    [`DELETE ${path}/:id`]: [...op('delete', 'delete'), ...deleteGuards(key), ...nested],
  };
}

// ---- extras.ts：引入、等级描述、编码规则、标准导入、发展通道、图谱 -------------------------------------------------
function importRoute(key: 'category' | 'level'): Obligation[] {
  const entry = call(
    `${EXTRAS}#registerImports`,
    "const ctx = await qualificationWriteContext(c, deps, object, 'create', revision(c))",
  );
  const registration = call(
    `${EXTRAS}#registerImports`,
    key === 'category'
      ? "importRoute( 'category', 'categories', input.categoryImport, CATEGORY_JOBS, ['categoryClass'], " +
          'config.importCategories, )'
      : "importRoute('level', 'levels', input.levelImport, LEVEL_JOBS, ['layer'], config.importLevels)",
  );
  const service = key === 'category' ? `${CONFIG}#importCategories` : `${CONFIG}#importLevels`;
  return [
    ...writeOp(key, 'create', entry, [registration]),
    ownerUnit(key, service, `const { ownerOrgId } = await ownerOf(tx, ctx, '${key}', body.ownerOrgId)`),
    ...(key === 'category'
      ? referenced(
          'categoryClass',
          [call(service, "await referenced(tx, ctx, 'categoryClass', body.classId)")],
          registration,
          { role: 'required' },
        )
      : referenced(
          'layer',
          [call(`${CONFIG}#insertLevel`, "if (body.layerId) await referenced(tx, ctx, 'layer', body.layerId)")],
          registration,
          { role: 'when', condition: 'body.layerId' },
        )),
    jobLinks(key, registration),
  ];
}

const DESCRIPTIONS = `${EXTRAS}#registerGradeDescriptions`;
const CODING = `${EXTRAS}#registerCodingRules`;
const CHANNELS = `${EXTRAS}#registerChannels`;
const CHANNELS_WRITE = call(
  CHANNELS,
  "const ctx = await qualificationWriteContext(c, deps, 'developmentChannel', 'update', revision(c))",
);
const CHANNEL_REFS = call(CHANNELS, "const w = await writeContext(c, deps, ctx, 'standard', ['category', 'level'])");
const PUT_CHANNELS = `${STANDARDS}#putChannels`;

const EXTRA: RequiredTable = {
  [`POST ${BASE}/categories/import`]: importRoute('category'),
  [`POST ${BASE}/levels/import`]: importRoute('level'),
  [`GET ${BASE}/targets/:id/grade-descriptions`]: [
    view('target', call(DESCRIPTIONS, "const ctx = await qualificationContext(c, deps, 'target')"), true),
  ],
  [`PUT ${BASE}/targets/:id/grade-descriptions/:detailId`]: writeOp(
    'target',
    'update',
    call(DESCRIPTIONS, "const ctx = await qualificationWriteContext(c, deps, 'target', 'update', revision(c))"),
  ),
  [`GET ${BASE}/coding-rules`]: [
    view('codingRule', call(CODING, "const ctx = await qualificationContext(c, deps, 'codingRule')")),
  ],
  [`PATCH ${BASE}/coding-rules/:item`]: writeOp(
    'codingRule',
    'update',
    call(CODING, "const ctx = await qualificationWriteContext(c, deps, 'codingRule', 'update', revision(c))"),
  ),
  [`POST ${BASE}/standards/import`]: writeOp(
    'standard',
    'update',
    call(
      `${EXTRAS}#registerStandardImport`,
      "const ctx = await qualificationWriteContext(c, deps, 'standard', 'update', 0)",
    ),
  ),
  [`GET ${BASE}/standards/:id/channels`]: [
    view(
      'developmentChannel',
      call(CHANNELS, "const ctx = await qualificationContext(c, deps, 'developmentChannel')"),
      true,
    ),
  ],
  [`PUT ${BASE}/standards/:id/channels`]: [
    ...writeOp('developmentChannel', 'update', CHANNELS_WRITE),
    ...referenced(
      'category',
      [call(PUT_CHANNELS, "await referenced(tx, ctx, 'category', channel.targetCategoryId, isNew)")],
      CHANNEL_REFS,
      { role: 'when', condition: 'newChannel' },
    ),
    ...referenced(
      'level',
      [call(PUT_CHANNELS, "await referenced(tx, ctx, 'level', channel.targetLevelId, isNew)")],
      CHANNEL_REFS,
      { role: 'when', condition: 'newChannel' },
    ),
  ],
  [`GET ${BASE}/standards/:id/chart`]: [
    view(
      'standard',
      call(`${EXTRAS}#registerChart`, "const ctx = await qualificationContext(c, deps, 'standard')"),
      true,
    ),
  ],
};

// ---- candidates.ts：新建时的所属管理单元候选（DEC-339 / DEC-316②）----------------------------------------------------
const OWNER_CODES = (['categoryClass', 'category', 'level', 'targetType', 'target'] as const).map(code).sort();
const CANDIDATE_ROUTE = `${CANDIDATES}#registerQualificationCandidates`;
const OWNER_ORGS: Obligation[] = [
  {
    perm: `obj:{${OWNER_CODES.join(',')}}:create`,
    facts: ['object:objectContext'],
    at: [
      call(CANDIDATE_ROUTE, "const ctx = await qualificationContext(c, deps, object, 'create')"),
      call(CANDIDATE_ROUTE, 'const object = ownerObject(c)'),
      { role: 'const', unit: `${CANDIDATES}#OWNER_OBJECTS`, anchor: "(object) => object !== 'standard'" },
      ...CONTEXT,
    ],
  },
  {
    perm: 'obj:TenantBase.Organization:view',
    purpose: 'disclosure:orgFields',
    need: list('org.scope'),
    note: '组织的编码 / 名称按组织查看权与组织员工应用范围披露（DEC-309 / DEC-316②）；范围事实随披露分流',
    facts: ['object:object.* 动作', 'scope:creator scope', 'scope:requestScope', 'scope:scopeSql'],
    at: [
      call(CANDIDATE_ROUTE, 'const org = await organizationAccess(c, deps, ctx)'),
      impl(
        `${CANDIDATES}#organizationAccess`,
        "if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] }))) {",
      ),
      {
        role: 'const',
        unit: `${CANDIDATES}#organizationAccess`,
        anchor: 'const code = MODULE_OBJECTS.organization.code',
      },
      ...SCOPE_AT['org.scope(qualification)'],
    ],
  },
];

export const QUALIFICATION: RequiredTable = {
  ...crud('categoryClass'),
  ...crud('category'),
  ...crud('layer'),
  ...crud('level'),
  ...crud('targetType'),
  ...crud('target'),
  ...crud('gradeScheme'),
  ...crud('standard'),
  ...EXTRA,
  [`GET ${BASE}/candidates/owner-orgs`]: OWNER_ORGS,
};
