/**
 * 必需项表：人才标准（modules/talent/routes.ts、candidates.ts、form-access.ts、model-image-routes.ts）。
 * 对象操作经 access.talentContext → module-route-access.objectContext（对象编码 TALENT_OBJECTS[对象].code）；写入口
 * 另经 talentWriteContext 叠加按钮（WRITE_BUTTONS）。六对象的增删改查都由 registerObject 按 spec 注册（路径由
 * spec.path 拼出，证据绑注册函数 + spec 常量）；被引用对象经 runTalentWrite → referenceAccess（查看权为假 → 范围 null）
 * → write-support.referenced 抛 403。人才标准里嵌套的指标内容按指标查看权披露（nestedDimension，不拒绝）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/talent';
const T = 'apps/api/src/modules/talent';
const ROUTES = `${T}/routes.ts`;
const ACCESS = `${T}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const CATALOG = 'packages/domain/src/talent/catalog.ts';
const OPS_UNION =
  'TalentCenter.Category|TalentCenter.DescriptionType|TalentCenter.Dimension|TalentCenter.DimensionLibrary|' +
  'TalentCenter.TalentCriterion|TalentCenter.TalentCriterionCategory';
const SIX =
  '{TalentCenter.Category,TalentCenter.DescriptionType,TalentCenter.Dimension,TalentCenter.DimensionLibrary,' +
  'TalentCenter.TalentCriterion,TalentCenter.TalentCriterionCategory}';

type Key = 'library' | 'dimensionCategory' | 'descriptionType' | 'dimension' | 'criterionCategory' | 'criterion';
type Operation = 'view' | 'create' | 'update' | 'delete';
/** 对象 → [编码后缀, 路径, spec 常量名]。 */
const OBJECTS: Readonly<Record<Key, readonly [string, string, string]>> = {
  library: ['DimensionLibrary', 'libraries', 'LIBRARIES'],
  dimensionCategory: ['Category', 'dimension-categories', 'DIMENSION_CATEGORIES'],
  descriptionType: ['DescriptionType', 'description-types', 'DESCRIPTION_TYPES'],
  dimension: ['Dimension', 'dimensions', 'DIMENSIONS'],
  criterionCategory: ['TalentCriterionCategory', 'criterion-categories', 'CATEGORIES'],
  criterion: ['TalentCriterion', 'criteria', 'CRITERIA'],
};
const code = (key: Key) => `TalentCenter.${OBJECTS[key][0]}`;
const CRIT = code('criterion');
const DIM = code('dimension');

const CONTEXT: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#talentContext`,
    anchor: 'return objectContext(c, deps, codeOf(object), operation, expectedRevision)',
  },
  {
    role: 'impl',
    unit: `${MRA}#objectContext`,
    anchor:
      'await requirePermission(deps.authorize, { ...ctx, action: ' +
      '`object.${operation}`, resource: objectCode, fields: [] })',
  },
];
const WRITE_CONTEXT: Evidence[] = [
  {
    role: 'impl',
    unit: `${ACCESS}#talentWriteContext`,
    anchor: 'await button(deps, ctx, codeOf(object), code, level)',
  },
  {
    role: 'impl',
    unit: `${MRA}#button`,
    anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
  },
];
const DATA_OPERATION: Evidence = {
  role: 'const',
  unit: `${ACCESS}#DATA_OPERATION`,
  anchor: "setDimensionCategory: 'update'",
};
const writeButton = (anchor: string): Evidence => ({ role: 'const', unit: `${ACCESS}#WRITE_BUTTONS`, anchor });
const BUTTON_CONST: Readonly<Record<string, Evidence>> = {
  create: writeButton("create: ['create', 'list']"),
  update: writeButton("update: ['update', 'detail']"),
  delete: writeButton("delete: ['delete', 'detail']"),
  setDimensionCategory: writeButton("setDimensionCategory: ['setDimensionCategory', 'detail']"),
};
const objectConst = (key: Key): Evidence => ({
  role: 'const',
  unit: `${CATALOG}#TALENT_OBJECTS>${key}`,
  anchor: `object( '${OBJECTS[key][0]}'`,
});
/** registerObject 按 spec 注册：spec 常量决定对象与路径，registerTalentRoutes 决定挂哪个 spec。 */
const spec = (key: Key): Evidence[] => [
  { role: 'const', unit: `${ROUTES}#${OBJECTS[key][2]}`, anchor: `object: '${key}', path: '${OBJECTS[key][1]}'` },
  {
    role: 'call',
    unit: `${ROUTES}#registerTalentRoutes`,
    anchor: `${key}: registerObject(router, deps, ${OBJECTS[key][2]})`,
  },
];
const REGISTER: Readonly<Record<'list' | 'detail' | 'create' | 'update' | 'delete', string>> = {
  list: 'router.get(path, async (c) => { const ctx = await talentContext(c, deps, spec.object)',
  detail: 'router.get(`${path}/:id`, async (c) => { const ctx = await talentContext(c, deps, spec.object)',
  create: "router.post(path, async (c) => { const ctx = await talentWriteContext(c, deps, spec.object, 'create'",
  update:
    "router.patch(`${path}/:id`, async (c) => { const ctx = await talentWriteContext(c, deps, spec.object, 'update'",
  delete:
    "router.delete(`${path}/:id`, async (c) => { const ctx = await talentWriteContext(c, deps, spec.object, 'delete'",
};
const registered = (entry: keyof typeof REGISTER): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#registerObject`,
  anchor: REGISTER[entry],
});

function objectOp(key: Key, operation: Operation, entry: keyof typeof REGISTER, write: boolean): Obligation {
  return {
    perm: `obj:${code(key)}:${operation}`,
    facts: ['object:objectContext', `objectOp:${OPS_UNION}:${operation}`, ...(write ? ['object:object.* 动作'] : [])],
    at: [registered(entry), ...spec(key), ...CONTEXT, objectConst(key)],
    ...(write ? { note: 'object.* 动作：写字段权（checkWriteFields）与被引用对象的查看权（referenceAccess）' } : {}),
  };
}
function writeBtn(key: Key, entry: 'create' | 'update' | 'delete'): Obligation {
  const level = entry === 'create' ? 'list' : 'detail';
  return {
    perm: `btn:${code(key)}#${entry}@${level}`,
    facts: ['button:button()'],
    at: [registered(entry), ...spec(key), ...WRITE_CONTEXT, BUTTON_CONST[entry]!, objectConst(key)],
  };
}

const SERVICE = {
  library: `${T}/library-service.ts`,
  dimension: `${T}/dimension-service.ts`,
  criterion: `${T}/criterion-service.ts`,
  support: `${T}/write-support.ts`,
  units: `${T}/owner-units.ts`,
};
const CHOOSE_UNIT: Evidence = {
  role: 'impl',
  unit: 'apps/api/src/modules/permission/owner-units.ts#chooseUnit',
  anchor: 'if (!units.length) throw noUnit()',
};
const OWNER_CALL: Readonly<Record<Exclude<Key, 'descriptionType'>, string>> = {
  library: `${SERVICE.library}#createLibrary`,
  dimensionCategory: `${SERVICE.library}#createDimensionCategory`,
  dimension: `${SERVICE.dimension}#createDimension`,
  criterionCategory: `${SERVICE.criterion}#createCategory`,
  criterion: `${SERVICE.criterion}#createCriterion`,
};
const ownerUnit = (key: Exclude<Key, 'descriptionType'>): Obligation => ({
  perm: `guard:talent.ownerUnit(${key})`,
  at: [
    { role: 'call', unit: OWNER_CALL[key], anchor: `await ownerUnit(tx, ctx, '${key}', requested)` },
    {
      role: 'impl',
      unit: `${SERVICE.units}#ownerUnit`,
      anchor: 'requireCreatable(ctx.scope, object, orgId, UNIT_NOT_FOUND)',
    },
    CHOOSE_UNIT,
  ],
});

/** 被引用对象：查看权为假 → 范围 null → referenced 抛 403；查看权是守卫内部义务。 */
const REFERENCED_IMPL: Evidence = {
  role: 'impl',
  unit: `${SERVICE.support}#referenced`,
  anchor: "if (scope === null) throw new AppError('FORBIDDEN', `无权查看${TALENT_LABELS[object]}`)",
};
const REFERENCE_ACCESS: Evidence[] = [
  {
    role: 'call',
    unit: `${ROUTES}#runTalentWrite`,
    anchor: 'const access = await referenceAccess(c, deps, ctx, object)',
  },
  {
    role: 'impl',
    unit: `${ROUTES}#referenceAccess`,
    anchor:
      "const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(object), fields: [] })",
  },
];
function referenced(target: Key, owner: Key, calls: readonly Evidence[]): Obligation[] {
  const carrier = `talent.referenced(${target})`;
  const references: Evidence = {
    role: 'const',
    unit: `${ROUTES}#${OBJECTS[owner][2]}>references`,
    anchor: `'${target}'`,
  };
  return [
    { perm: `guard:${carrier}`, at: [...calls, REFERENCED_IMPL, references] },
    {
      perm: `obj:${code(target)}:view`,
      purpose: `guard:${carrier}`,
      at: [...REFERENCE_ACCESS, references, objectConst(target)],
    },
  ];
}
const LIBRARY_CREATABLE = (call: Evidence): Obligation => ({
  perm: 'guard:talent.libraryCreatable',
  at: [
    call,
    {
      role: 'impl',
      unit: `${SERVICE.support}#requireLibraryCreatable`,
      anchor: 'requireCreatable(ctx.scope, object, library.orgId, `${TALENT_LABELS.library}不存在`)',
    },
  ],
});
const descriptionTypeChoice = (call: Evidence): Obligation => ({
  perm: 'guard:talent.descriptionTypeChoice',
  note: '发展建议类型只校验存在且启用（400），不是权限判定；声明登记为具名守卫，表照登（声明偏严，不是削弱）',
  at: [
    call,
    {
      role: 'impl',
      unit: `${SERVICE.dimension}#checkSuggestionTypes`,
      anchor: "throw new AppError('VALIDATION_FAILED', '发展建议类型不存在或已停用', {",
    },
  ],
});
const CHECK_REFERENCES = `${SERVICE.criterion}#checkReferences`;
const COPY_CATEGORY_NAME: Obligation = {
  perm: 'guard:talent.copyCategoryName',
  note: '指标类别名称是否随引用复制只看指标 categoryName 的查看权，不拒绝；声明登记为具名守卫，表照登',
  at: [
    {
      role: 'call',
      unit: CHECK_REFERENCES,
      anchor:
        "const copyable = 'dimension' in ctx.referenceFields && " +
        "fieldVisible(ctx.referenceFields.dimension, 'categoryName')",
    },
  ],
};
const DIMENSION_REFERENCES: Evidence = {
  role: 'call',
  unit: CHECK_REFERENCES,
  anchor: "if (fresh.length && ctx.references.dimension === null) throw new AppError('FORBIDDEN', '无权查看指标')",
};

/** 人才标准里嵌套的指标内容：指标查看权为假只省略内容，不拒绝（DEC-281⑪ / DEC-178）。 */
const NESTED_DIMENSION: Obligation = {
  perm: `obj:${DIM}:view`,
  purpose: 'disclosure:nestedDimension',
  at: [
    { role: 'call', unit: `${ROUTES}#presenter`, anchor: 'const nested = await nestedDimensionReader(c, deps, ctx)' },
    {
      role: 'impl',
      unit: `${ACCESS}#nestedDimensionReader`,
      anchor: "const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] })",
    },
    { role: 'impl', unit: `${ACCESS}#nestedDimensionReader`, anchor: 'if (!canView) return () => undefined' },
    objectConst('dimension'),
  ],
};
const nested = (key: Key) => (key === 'criterion' ? [NESTED_DIMENSION] : []);

const call = (unit: string, anchor: string): Evidence => ({ role: 'call', unit, anchor });
/** 新建 / 编辑各对象额外的守卫（与声明 CREATE_GUARDS / UPDATE_GUARDS 对应，逐个绑服务里的判定处）。 */
function createGuards(key: Key): Obligation[] {
  const lib = call(
    `${SERVICE.library}#createDimensionCategory`,
    "await referenced(tx, ctx, 'library', input.libraryId)",
  );
  const dimLib = call(`${SERVICE.dimension}#createDimension`, "await referenced(tx, ctx, 'library', input.libraryId)");
  const category = call(
    `${SERVICE.dimension}#referencedCategory`,
    "await referenced(tx, ctx, 'dimensionCategory', categoryId)",
  );
  switch (key) {
    case 'library':
      return [ownerUnit('library')];
    case 'dimensionCategory':
      return [
        ...referenced('library', key, [lib]),
        LIBRARY_CREATABLE(
          call(
            `${SERVICE.library}#createDimensionCategory`,
            "requireLibraryCreatable(ctx, 'dimensionCategory', library)",
          ),
        ),
        ownerUnit('dimensionCategory'),
      ];
    case 'descriptionType':
      return [];
    case 'dimension':
      return [
        ...referenced('library', key, [dimLib]),
        LIBRARY_CREATABLE(
          call(`${SERVICE.dimension}#createDimension`, "requireLibraryCreatable(ctx, 'dimension', library)"),
        ),
        ...referenced('dimensionCategory', key, [
          category,
          call(
            `${SERVICE.dimension}#createDimension`,
            'await referencedCategory(tx, ctx, input.libraryId, input.categoryId)',
          ),
        ]),
        ownerUnit('dimension'),
        descriptionTypeChoice(
          call(`${SERVICE.dimension}#createDimension`, 'await checkSuggestionTypes(tx, ctx, suggestions, [])'),
        ),
      ];
    case 'criterionCategory':
      return [ownerUnit('criterionCategory')];
    case 'criterion':
      return [
        ownerUnit('criterion'),
        ...referenced('criterionCategory', key, [
          call(
            `${SERVICE.criterion}#createCriterion`,
            "await referenced(tx, ctx, 'criterionCategory', input.categoryId)",
          ),
        ]),
        ...referenced('dimension', key, [DIMENSION_REFERENCES]),
        COPY_CATEGORY_NAME,
      ];
  }
}
function updateGuards(key: Key): Obligation[] {
  switch (key) {
    case 'dimension':
      return [
        ...referenced('dimensionCategory', key, [
          call(`${SERVICE.dimension}#referencedCategory`, "await referenced(tx, ctx, 'dimensionCategory', categoryId)"),
          call(
            `${SERVICE.dimension}#updateDimension`,
            'await referencedCategory(tx, ctx, before.libraryId, fields.categoryId)',
          ),
        ]),
        descriptionTypeChoice(
          call(
            `${SERVICE.dimension}#updateDimension`,
            'await checkSuggestionTypes(tx, ctx, suggestions, before.suggestions)',
          ),
        ),
      ];
    case 'criterion':
      return [
        ...referenced('criterionCategory', key, [
          call(
            `${SERVICE.criterion}#updateCriterion`,
            "await referenced(tx, ctx, 'criterionCategory', fields.categoryId)",
          ),
        ]),
        ...referenced('dimension', key, [DIMENSION_REFERENCES]),
        COPY_CATEGORY_NAME,
        {
          perm: 'guard:talent.relationUnit',
          at: [
            call(`${SERVICE.criterion}#updateCriterion`, 'await relationUnit(tx, ctx, relationOwnerOrgId)'),
            {
              role: 'impl',
              unit: `${SERVICE.units}#relationUnit`,
              anchor: 'chooseUnit(tx, ctx, TALENT_APP, requested)',
            },
            CHOOSE_UNIT,
          ],
        },
      ];
    default:
      return [];
  }
}

function crud(key: Key): RequiredTable {
  const path = `${BASE}/${OBJECTS[key][1]}`;
  return {
    [`GET ${path}`]: [objectOp(key, 'view', 'list', false), ...nested(key)],
    [`GET ${path}/:id`]: [objectOp(key, 'view', 'detail', false), ...nested(key)],
    [`POST ${path}`]: [
      objectOp(key, 'create', 'create', true),
      writeBtn(key, 'create'),
      ...createGuards(key),
      ...nested(key),
    ],
    [`PATCH ${path}/:id`]: [
      objectOp(key, 'update', 'update', true),
      writeBtn(key, 'update'),
      ...updateGuards(key),
      ...nested(key),
    ],
    [`DELETE ${path}/:id`]: [objectOp(key, 'delete', 'delete', true), writeBtn(key, 'delete'), ...nested(key)],
  };
}

// ---- 模型图（F-038）：权限随人才标准对象 ---------------------------------------------------------------------------
const IMAGE = `${T}/model-image-routes.ts`;
const IMAGE_SERVICE = `${T}/model-image-service.ts`;
const IMAGE_BASE: Evidence = {
  role: 'const',
  unit: `${IMAGE}#BASE`,
  anchor: '`${TALENT_BASE}/criteria/:id/model-image`',
};
const imageRoute = (anchor: string) => call(`${IMAGE}#registerModelImageRoutes`, anchor);
const critView = (route: Evidence, more: Evidence[] = []): Obligation => ({
  perm: `obj:${CRIT}:view`,
  facts: ['object:objectContext', `objectOp:${CRIT}:view`],
  at: [route, ...more, ...CONTEXT, IMAGE_BASE, objectConst('criterion')],
});
const IMAGE_WRITE = call(
  `${IMAGE}#imageWriteContext`,
  "const ctx = await talentWriteContext(c, deps, 'criterion', 'update', revision(c))",
);
function imageWrite(route: string, guards: Obligation[] = []): Obligation[] {
  const entry = imageRoute(route);
  return [
    {
      perm: `obj:${CRIT}:update`,
      facts: [`objectOp:${CRIT}:update`],
      at: [entry, IMAGE_WRITE, ...CONTEXT, IMAGE_BASE, objectConst('criterion')],
    },
    {
      perm: `btn:${CRIT}#update@detail`,
      facts: ['button:button()'],
      at: [entry, IMAGE_WRITE, ...WRITE_CONTEXT, BUTTON_CONST['update']!, objectConst('criterion')],
    },
    critView(entry, [call(`${IMAGE}#imageWriteContext`, "await talentContext(c, deps, 'criterion')")]),
    ...guards,
  ];
}
const CAN_EDIT = call(`${IMAGE}#present`, "await talentWriteContext(c, deps, 'criterion', 'update', state.revision)");
const MODEL_IMAGE: RequiredTable = {
  [`GET ${BASE}/criteria/:id/model-image`]: [
    critView(imageRoute("router.get(BASE, async (c) => { const ctx = await talentContext(c, deps, 'criterion')")),
    {
      perm: `obj:${CRIT}:update`,
      purpose: 'disclosure:canEdit',
      facts: [`objectOp:${CRIT}:update`],
      at: [CAN_EDIT, { role: 'impl', unit: `${IMAGE}#present`, anchor: 'canEdit = true' }, ...CONTEXT],
    },
    {
      perm: `btn:${CRIT}#update@detail`,
      purpose: 'disclosure:canEdit',
      facts: ['button:button()'],
      at: [CAN_EDIT, ...WRITE_CONTEXT, BUTTON_CONST['update']!],
    },
  ],
  [`GET ${BASE}/criteria/:id/model-image/attachments/:attachmentId/content`]: [
    critView(
      imageRoute(
        'router.get(`${BASE}/attachments/:attachmentId/content`, async ' +
          "(c) => { const ctx = await talentContext(c, deps, 'criterion')",
      ),
    ),
    {
      perm: 'guard:talent.attachmentCurrent',
      at: [
        imageRoute('return service.imageContent(tx, ctx.tenantId, id, attachmentId)'),
        { role: 'impl', unit: `${IMAGE_SERVICE}#imageContent`, anchor: "eq(A.status, 'uploaded')" },
        {
          role: 'impl',
          unit: `${IMAGE_SERVICE}#imageContent`,
          anchor: "if (!image?.contentBase64) throw new AppError('NOT_FOUND', '模型图附件不存在')",
        },
      ],
    },
  ],
  [`POST ${BASE}/criteria/:id/model-image/attachments`]: imageWrite(
    'router.post(`${BASE}/attachments`, async (c) => { sameOrigin(c); const ctx = await imageWriteContext(c, deps)',
  ),
  [`POST ${BASE}/criteria/:id/model-image/attachments/:attachmentId/upload`]: imageWrite(
    'router.post(`${BASE}/attachments/:attachmentId/upload`, async (c) => { sameOrigin(c); ' +
      'const ctx = await imageWriteContext(c, deps)',
    [
      {
        perm: 'guard:talent.attachmentRegistered',
        at: [
          call(
            `${IMAGE_SERVICE}#uploadModelImage`,
            "if (attachment.status !== 'registered') throw new AppError('NOT_FOUND', '模型图附件不存在')",
          ),
        ],
      },
    ],
  ),
  [`DELETE ${BASE}/criteria/:id/model-image`]: imageWrite(
    'router.delete(BASE, async (c) => { sameOrigin(c); const ctx = await imageWriteContext(c, deps)',
  ),
};

// ---- 候选（candidates.ts）---------------------------------------------------------------------------------------
const CANDIDATES = `${T}/candidates.ts`;
const candidateRoute = (anchor: string) => call(`${CANDIDATES}#registerCandidates`, anchor);
const dimensionView = (route: Evidence): Obligation => ({
  perm: `obj:${DIM}:view`,
  facts: ['object:objectContext', `objectOp:${DIM}:view`],
  at: [route, ...CONTEXT, objectConst('dimension')],
});
const CANDIDATE_CONTEXT = `${CANDIDATES}#candidateContext`;
const OWNER_ORGS: Obligation[] = [
  {
    perm: `obj:{${['Category', 'Dimension', 'DimensionLibrary', 'TalentCriterion', 'TalentCriterionCategory']
      .map((name) => `TalentCenter.${name}`)
      .join(',')}}:create`,
    or: 'candidate:create',
    facts: ['object:objectContext', 'or:talent.candidateContext'],
    at: [
      candidateRoute('const ctx = await candidateContext(c, deps, object)'),
      call(CANDIDATE_CONTEXT, "return await talentContext(c, deps, object, 'create')"),
      { role: 'const', unit: `${CANDIDATES}#OWNER_OBJECTS`, anchor: "'criterionCategory'" },
      ...CONTEXT,
    ],
  },
  {
    perm: `obj:${CRIT}:update`,
    or: 'candidate:edit',
    facts: [`objectOp:${CRIT}:update`],
    at: [
      call(CANDIDATE_CONTEXT, "const ctx = await talentWriteContext(c, deps, 'criterion', 'update', 0)"),
      ...CONTEXT,
    ],
  },
  {
    perm: `btn:${CRIT}#update@detail`,
    or: 'candidate:edit',
    facts: ['button:button()'],
    at: [
      call(CANDIDATE_CONTEXT, "const ctx = await talentWriteContext(c, deps, 'criterion', 'update', 0)"),
      ...WRITE_CONTEXT,
      BUTTON_CONST['update']!,
    ],
  },
  {
    perm: 'guard:talent.criterionDimensionsEditable',
    or: 'candidate:edit',
    facts: ['object:object.* 动作'],
    at: [
      call(CANDIDATE_CONTEXT, "await checkWriteFields(deps, ctx, 'criterion', 'update', { dimensions: [] })"),
      {
        role: 'impl',
        unit: `${ACCESS}#checkWriteFields`,
        anchor: 'return writeFields(deps, ctx, codeOf(object), operation, fields)',
      },
    ],
  },
  {
    perm: 'guard:talent.queryObjectIsCriterion',
    or: 'candidate:edit',
    at: [
      call(
        CANDIDATE_CONTEXT,
        "if (object !== 'criterion' || !(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error",
      ),
    ],
  },
  {
    perm: 'obj:TenantBase.Organization:view',
    purpose: 'disclosure:orgFields',
    note: '组织的编码 / 名称按组织查看权与组织员工应用范围披露（DEC-309 / DEC-316②）；范围事实随披露分流',
    facts: ['object:object.* 动作', 'scope:creator scope', 'scope:requestScope', 'scope:scopeSql'],
    at: [
      candidateRoute('const org = await organizationAccess(c, deps, ctx)'),
      {
        role: 'impl',
        unit: `${CANDIDATES}#organizationAccess`,
        anchor: "if (!(await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] }))) {",
      },
      {
        role: 'const',
        unit: `${CANDIDATES}#organizationAccess`,
        anchor: 'const code = MODULE_OBJECTS.organization.code',
      },
    ],
  },
];

// ---- 表单权限契约（form-access.ts）与「设置指标类别」---------------------------------------------------------------
const FORM = `${T}/form-access.ts#talentFormHandler`;
const FORM_ROUTE = call(`${ROUTES}#registerTalentRoutes`, 'return forms[object as TalentObject](c)');
const FORM_WRITE = call(FORM, 'const ctx = await talentWriteContext(c, deps, spec.object, operation, 0)');
const FORMS: Obligation[] = [
  {
    perm: `obj:${SIX}:{create,update}`,
    facts: ['object:objectContext', `objectOp:${OPS_UNION}:create|update`],
    at: [FORM_ROUTE, FORM_WRITE, ...CONTEXT],
  },
  {
    perm: `btn:${SIX}#{create@list,update@detail}`,
    facts: ['button:button()'],
    at: [FORM_ROUTE, FORM_WRITE, ...WRITE_CONTEXT, BUTTON_CONST['create']!, BUTTON_CONST['update']!],
  },
  {
    perm: 'guard:talent.formScope(operation)',
    note: 'update 按详情范围定位（不可见 404）；create 不按范围拒绝，无可用单元 / 范围随 200 返回 blockedReason',
    at: [FORM_ROUTE, call(FORM, 'requireVisible(scope, spec.object, spec.owner(found))')],
  },
  {
    perm: `obj:${SIX}:view`,
    facts: [`objectOp:${OPS_UNION}:view`],
    at: [FORM_ROUTE, call(FORM, 'await talentContext(c, deps, spec.object)'), ...CONTEXT],
  },
];
const BATCH = call(
  `${ROUTES}#registerDimensionCategoryBatch`,
  "const ctx = await talentWriteContext(c, deps, 'criterion', 'setDimensionCategory', revision(c))",
);
const DIMENSION_CATEGORY: Obligation[] = [
  {
    perm: `obj:${CRIT}:update`,
    facts: ['object:objectContext', 'object:object.* 动作'],
    at: [BATCH, ...CONTEXT, DATA_OPERATION, objectConst('criterion')],
  },
  {
    perm: `btn:${CRIT}#setDimensionCategory@detail`,
    facts: ['button:button()'],
    at: [BATCH, ...WRITE_CONTEXT, BUTTON_CONST['setDimensionCategory']!, objectConst('criterion')],
  },
  NESTED_DIMENSION,
];

export const TALENT: RequiredTable = {
  ...MODEL_IMAGE,
  [`GET ${BASE}/candidates/dimensions`]: [
    dimensionView(
      candidateRoute(
        'router.get(`${TALENT_BASE}/candidates/dimensions`, async (c) ' +
          "=> { const ctx = await talentContext(c, deps, 'dimension')",
      ),
    ),
  ],
  [`GET ${BASE}/candidates/description-types`]: [
    dimensionView(
      candidateRoute(
        'router.get(`${TALENT_BASE}/candidates/description-types`, async (c) => { ' +
          "const ctx = await talentContext(c, deps, 'dimension')",
      ),
    ),
  ],
  [`GET ${BASE}/candidates/owner-orgs`]: OWNER_ORGS,
  ...crud('library'),
  ...crud('dimensionCategory'),
  ...crud('descriptionType'),
  ...crud('dimension'),
  ...crud('criterionCategory'),
  ...crud('criterion'),
  [`GET ${BASE}/forms/:object`]: FORMS,
  [`POST ${BASE}/criteria/:id/dimension-category`]: DIMENSION_CATEGORY,
};
