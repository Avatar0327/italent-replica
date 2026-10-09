/**
 * 必需项表：360 度评估管理端（modules/survey360/*.ts，挂在 /api/tenant/survey360 子应用）与作答 / 确认链接
 * （answering.ts，挂在 /api/survey360/link）。管理端每个路由经 context.read / write → routeNeed：objectContext
 * （对象.操作）+ 按钮（显式按钮，或对象目录里与操作同名的按钮，buttonOf），命令事务内 requireNeed 按同一对象 / 按钮
 * 重验；资源守卫（options.guard）、载荷引用（refs）、隐式写入的人员（also → routeNeed）、命令前员工信息查看权
 * （preflight → routeEmployeeScope）逐个绑判定处。链接入口不经成员中间件，令牌在每个处理函数里解析（linkTenant + resolve）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const S = 'apps/api/src/modules/survey360';
const CONTEXT = `${S}/context.ts`;
const CATALOG = 'packages/domain/src/survey360/catalog.ts';
const BASE = '/api/tenant/survey360';
const EMPLOYEE = 'TenantBase.EmployeeInformation';

type Key = 'activity' | 'relation' | 'result' | 'questionnaire' | 'person' | 'settings';
type Operation = 'view' | 'create' | 'update' | 'delete';
const NAMES: Readonly<Record<Key, string>> = {
  activity: 'Activity',
  relation: 'Relation',
  result: 'Result',
  questionnaire: 'Questionnaire',
  person: 'Person',
  settings: 'Settings',
};
const code = (key: Key) => `Survey360.${NAMES[key]}`;
const call = (unit: string, anchor: string): Evidence => ({ role: 'call', unit, anchor });
const objectConst = (key: Key): Evidence => ({
  role: 'const',
  unit: `${CATALOG}#SURVEY360_OBJECTS>${key}`,
  anchor: `object( '${NAMES[key]}'`,
});

const ROUTE_NEED: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#routeNeed`,
  anchor: "const ctx = await objectContext(c, deps, code, need.operation ?? 'view')",
};
const ROUTE_BUTTON: Evidence[] = [
  {
    role: 'impl',
    unit: `${CONTEXT}#routeNeed`,
    anchor: 'if (buttonCode) await button(deps, ctx, code, buttonCode, levelOf(need.object, buttonCode))',
  },
  {
    role: 'impl',
    unit: `${CONTEXT}#buttonOf`,
    anchor: 'return buttons.some((b) => b.code === operation) ? operation : undefined',
  },
];
const IN_TRANSACTION: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#requireNeed`,
  anchor: 'if (!(await can(tx, deps, tenant, need.object, need.operation, buttonOf(need))))',
};
const READ: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#read`,
  anchor: 'const route = await routeNeed(c, deps, need)',
};
const WRITE: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#write`,
  anchor: 'const route = await routeNeed(c, deps, options.need)',
};
/** 按钮在对象目录里的登记（层级取自这里，levelOf）。 */
const CRUD_BUTTONS: Readonly<Record<string, string>> = {
  create: "button('create', 'list', 'create')",
  update: "button('update', 'detail', 'update')",
  delete: "button('delete', 'detail', 'delete')",
};
const BUTTON_ANCHORS: Readonly<Record<string, string>> = {
  enable: "button('enable', 'detail', 'update')",
  disable: "button('disable', 'detail', 'update')",
  import: "button('import', 'list', 'create')",
  autoAdd: "button('autoAdd', 'list', 'create')",
  invite: "button('invite', 'list', 'update')",
  sync: "button(SURVEY360_BUTTONS.sync, 'list')",
  finePermission: "button(SURVEY360_BUTTONS.finePermission, 'list', 'update')",
  editOthers: "button(SURVEY360_BUTTONS.editOthers, 'detail', 'update')",
};
function buttonConst(key: Key, button: string): Evidence {
  // 活动 / 评价关系 / 套卷的增删改按钮来自公共 crud 常量；人员与设置在各自对象里逐个登记
  if (CRUD_BUTTONS[button] && ['activity', 'relation', 'questionnaire'].includes(key)) {
    return { role: 'const', unit: `${CATALOG}#crud`, anchor: CRUD_BUTTONS[button]! };
  }
  return {
    role: 'const',
    unit: `${CATALOG}#SURVEY360_OBJECTS>${key}`,
    anchor: BUTTON_ANCHORS[button] ?? CRUD_BUTTONS[button]!,
  };
}
const LEVELS: Readonly<Record<string, string>> = {
  create: 'list',
  update: 'detail',
  delete: 'detail',
  enable: 'detail',
  disable: 'detail',
  import: 'list',
  autoAdd: 'list',
  invite: 'list',
  sync: 'list',
  finePermission: 'list',
  editOthers: 'detail',
};

interface Route {
  readonly file: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly key: Key;
  readonly operation?: Operation;
  /** 显式按钮或与操作同名的按钮；查看不要按钮。 */
  readonly button?: string;
  /** 路由处理函数里的 need 原文（read / write 的入参）。 */
  readonly need: string;
  /** need 是文件内常量（VIEW / SYNC / EDIT）时的登记。 */
  readonly needConst?: Evidence;
  /** 探测器取不到对象.操作事实（need 是内联字面量且不是标准写法）时为 false。 */
  readonly opFact?: boolean;
  readonly extra?: (entry: Evidence) => Obligation[];
}

const unitOf = (r: Pick<Route, 'file' | 'method' | 'path'>) => `${S}/${r.file}#route:${r.method} ${r.path}`;

function obligations(r: Route): Obligation[] {
  const operation = r.operation ?? 'view';
  const entry = call(unitOf(r), r.need);
  const write = operation !== 'view' || r.method !== 'GET';
  const common = [entry, ...(r.needConst ? [r.needConst] : []), write ? WRITE : READ];
  const out: Obligation[] = [
    {
      perm: `obj:${code(r.key)}:${operation}`,
      facts: [
        'object:survey360 read/write(need)',
        ...(r.opFact === false ? [] : [`objectOp:${code(r.key)}:${operation}`]),
      ],
      at: [...common, ROUTE_NEED, ...(write ? [IN_TRANSACTION] : []), objectConst(r.key)],
    },
  ];
  if (r.button) {
    out.push({
      perm: `btn:${code(r.key)}#${r.button}@${LEVELS[r.button]}`,
      facts: ['button:survey360 need button'],
      at: [...common, ...ROUTE_BUTTON, ...(write ? [IN_TRANSACTION] : []), buttonConst(r.key, r.button)],
    });
  }
  return [...out, ...(r.extra?.(entry) ?? [])];
}

// ---- 守卫 ---------------------------------------------------------------------------------------------------------
const OPTION_GUARD: Evidence = { role: 'impl', unit: `${CONTEXT}#write`, anchor: 'await options.guard?.(tx, admin)' };
const OPTION_REFS: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#write`,
  anchor: 'if (refs) await withTenant(deps.db, tenant.tenantId, (tx) => refs(tx, admin, input))',
};
const OPTION_PREFLIGHT: Evidence = {
  role: 'impl',
  unit: `${CONTEXT}#write`,
  anchor: 'await options.preflight?.(admin)',
};
const REQUIRE_ACTIVITY: Evidence = {
  role: 'impl',
  unit: `${S}/access.ts#requireActivity`,
  anchor: "if (!row) fail('NOT_FOUND', '活动不存在')",
};
const VISIBLE_OBJECT: Evidence = {
  role: 'impl',
  unit: `${S}/access.ts#requireVisibleObject`,
  anchor: "fail('NOT_FOUND', '评价对象不存在')",
};
const GUARDED: Evidence = {
  role: 'impl',
  unit: `${S}/activities.ts#guarded`,
  anchor: 'void (await requireActivity(tx, admin, id))',
};
const OBJECT_GUARD: Evidence = {
  role: 'impl',
  unit: `${S}/relations.ts#objectGuard`,
  anchor: 'await requireVisibleObject(tx, admin, id, objectId, false, removed)',
};
const resource = (entry: Evidence, anchor: string, impls: readonly Evidence[]): Obligation => ({
  perm: 'guard:survey360.resourceGuard',
  at: [{ ...entry, anchor }, OPTION_GUARD, ...impls],
});
const activityGuard = (entry: Evidence) => resource(entry, 'guard: guarded(id)', [GUARDED, REQUIRE_ACTIVITY]);
const objectGuard = (entry: Evidence, anchor = 'guard: objectGuard(id, objectId)') =>
  resource(entry, anchor, [OBJECT_GUARD, REQUIRE_ACTIVITY, VISIBLE_OBJECT]);
/** 改 / 删他人创建的套卷：本人创建，或持 editOthers 按钮（守卫内部义务）。 */
function editableBy(entry: Evidence, anchor: string): Obligation[] {
  const impl: Evidence = {
    role: 'impl',
    unit: `${S}/questionnaires.ts#editableBy`,
    anchor: "if (!(await can(tx, deps, tenant, 'questionnaire', 'update', BUTTONS.editOthers)))",
  };
  return [
    resource(entry, anchor, [impl]),
    {
      perm: `btn:${code('questionnaire')}#editOthers@detail`,
      purpose: 'guard:survey360.resourceGuard',
      note: '本人创建的套卷不要求该按钮',
      at: [{ ...entry, anchor }, impl, buttonConst('questionnaire', 'editOthers')],
    },
    {
      perm: `obj:${code('questionnaire')}:update`,
      purpose: 'guard:survey360.resourceGuard',
      note: 'editOthers 按 can(questionnaire, update, editOthers) 判定：数据操作与按钮同时要求',
      at: [{ ...entry, anchor }, impl],
    },
  ];
}
const refs = (entry: Evidence, anchor: string, impl: Evidence): Obligation => ({
  perm: 'guard:survey360.payloadRefs',
  at: [{ ...entry, anchor }, OPTION_REFS, impl],
});
const PERSON_REFS: Evidence = {
  role: 'impl',
  unit: `${S}/relations.ts#personRefs`,
  anchor: 'void (await referencedPerson(tx, admin, ref))',
};
const REQUIRE_SUPERIOR: Evidence = { role: 'impl', unit: `${S}/people.ts#requireSuperior`, anchor: 'if (id === self)' };
/** 隐式写入的 360 人员：also → routeFields → routeNeed（人员的数据操作 + 同名按钮 + 字段），命令事务内 requireNeed 重验。 */
function also(entry: Evidence, anchor: string, operations: readonly ('create' | 'update')[], impl?: Evidence) {
  const routeFields: Evidence = {
    role: 'impl',
    unit: `${CONTEXT}#routeFields`,
    anchor: 'const ctx = await routeNeed(c, deps, extra.need)',
  };
  const inTx: Evidence = {
    role: 'impl',
    unit: `${CONTEXT}#write`,
    anchor: 'for (const extra of also) await requireNeed(tx, deps, tenant, extra.need)',
  };
  const at = [{ ...entry, anchor }, ...(impl ? [impl] : []), routeFields, inTx];
  return [
    { perm: 'guard:survey360.alsoObjects', at },
    ...operations.flatMap((operation): Obligation[] => [
      {
        perm: `obj:${code('person')}:${operation}`,
        purpose: 'guard:survey360.alsoObjects',
        at: [...at, ROUTE_NEED, objectConst('person')],
      },
      {
        perm: `btn:${code('person')}#${operation}@${LEVELS[operation]}`,
        purpose: 'guard:survey360.alsoObjects',
        at: [...at, ...ROUTE_BUTTON, buttonConst('person', operation)],
      },
    ]),
  ];
}
const PERSON_ALSO: Evidence = {
  role: 'impl',
  unit: `${S}/relations.ts#personAlso`,
  anchor: "ref.person ? [{ need: { object: 'person', operation: 'create' }, fields: Object.keys(ref.person) }] : []",
};
const IMPORT_ALSO: Evidence = {
  role: 'impl',
  unit: `${S}/relations.ts#importAlso`,
  anchor: "{ need: { object: 'person', operation: 'update' }, fields: fields.filter((f) => f !== 'email') }",
};
const preflight = (entry: Evidence, anchor: string): Obligation => ({
  perm: 'guard:survey360.preflight',
  at: [{ ...entry, anchor }, OPTION_PREFLIGHT],
});
const UNRESTRICTED_IMPL: Evidence = {
  role: 'impl',
  unit: `${S}/people.ts#requireUnrestricted`,
  anchor: "fail('FORBIDDEN', '开启精细化权限后，同步冲突与关联日志只由系统管理员处理', 'FINE_PERMISSION_RESTRICTED')",
};
const unrestricted = (entry: Evidence, anchor: string): Obligation => ({
  perm: 'guard:survey360.unrestricted',
  facts: ['guard:survey360.unrestricted'],
  at: [{ ...entry, anchor }, UNRESTRICTED_IMPL],
});

/** 员工信息查看权（routeEmployeeScope：objectContext(PERSONNEL_OBJECT, 'view')；事务内 syncAccess 无查看权 403）。 */
const ROUTE_EMPLOYEE: Evidence = {
  role: 'impl',
  unit: `${S}/sync.ts#routeEmployeeScope`,
  anchor: "const ctx = await objectContext(c, deps, PERSONNEL_OBJECT, 'view')",
};
const SYNC_ACCESS: Evidence = {
  role: 'impl',
  unit: `${S}/sync.ts#syncAccess`,
  anchor: "if (!scope) fail('FORBIDDEN', '无权查看组织员工信息', 'NO_EMPLOYEE_ACCESS')",
};
const EMPLOYEE_CONST: Evidence = {
  role: 'const',
  unit: 'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECT',
  anchor: "'TenantBase.EmployeeInformation'",
};
const employeeView = (calls: readonly Evidence[], facts: readonly string[]): Obligation => ({
  perm: `obj:${EMPLOYEE}:view`,
  facts,
  at: [...calls, ROUTE_EMPLOYEE, SYNC_ACCESS, EMPLOYEE_CONST],
});
const ROUTE_EMPLOYEE_FACTS = ['object:objectContext', `objectOp:${EMPLOYEE}:view`, 'object:object.* 动作'];

const VIEW = (file: string, key: Key): Evidence => ({
  role: 'const',
  unit: `${S}/${file}#VIEW`,
  anchor: `{ object: '${key}' }`,
});
const SYNC_NEED: Evidence = {
  role: 'const',
  unit: `${S}/sync.ts#SYNC`,
  anchor: "{ object: 'person', button: BUTTONS.sync }",
};
const EDIT_NEED: Evidence = {
  role: 'const',
  unit: `${S}/activities.ts#registerGrants>EDIT`,
  anchor: "{ object: 'activity', operation: 'update' }",
};

const ROUTES: readonly Route[] = [
  // ---- settings.ts ------------------------------------------------------------------------------------------------
  {
    file: 'settings.ts',
    method: 'GET',
    path: '/settings',
    key: 'settings',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('settings.ts', 'settings'),
  },
  {
    file: 'settings.ts',
    method: 'PUT',
    path: '/settings',
    key: 'settings',
    operation: 'update',
    button: 'finePermission',
    need: "need: { object: 'settings', operation: 'update', button: BUTTONS.finePermission }",
  },
  {
    file: 'settings.ts',
    method: 'GET',
    path: '/roles',
    key: 'settings',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('settings.ts', 'settings'),
  },
  {
    file: 'settings.ts',
    method: 'POST',
    path: '/roles',
    key: 'settings',
    operation: 'create',
    button: 'create',
    need: "need: { object: 'settings', operation: 'create' }",
  },
  {
    file: 'settings.ts',
    method: 'PUT',
    path: '/roles/:id',
    key: 'settings',
    operation: 'update',
    button: 'update',
    need: "need: { object: 'settings', operation: 'update' }",
  },
  // ---- sync.ts ----------------------------------------------------------------------------------------------------
  {
    file: 'sync.ts',
    method: 'GET',
    path: '/people/sync-conflicts',
    key: 'person',
    button: 'sync',
    need: 'read( c, deps, SYNC',
    needConst: SYNC_NEED,
    extra: (entry) => [
      unrestricted(entry, 'requireUnrestricted(admin)'),
      employeeView(
        [{ ...entry, anchor: 'await syncAccess(tx, deps, tenant, `${PERSONNEL_OBJECT}.list`)' }],
        ['object:object.* 动作'],
      ),
    ],
  },
  {
    file: 'sync.ts',
    method: 'POST',
    path: '/people/sync',
    key: 'person',
    button: 'sync',
    need: 'need: SYNC',
    needConst: SYNC_NEED,
    extra: (entry) => {
      const anchor = 'preflight: async () => void (employees = await routeEmployeeScope(c, deps))';
      return [preflight(entry, anchor), employeeView([{ ...entry, anchor }], ROUTE_EMPLOYEE_FACTS)];
    },
  },
  {
    file: 'sync.ts',
    method: 'POST',
    path: '/people/sync-conflicts/:id/resolve',
    key: 'person',
    button: 'sync',
    need: 'need: SYNC',
    needConst: SYNC_NEED,
    extra: (entry) => [
      resource(entry, 'guard: async (_tx, admin) => requireUnrestricted(admin)', [UNRESTRICTED_IMPL]),
      refs(entry, 'refs: (tx, admin, input) => linkTargetRefs(tx, admin, id, input)', {
        role: 'impl',
        unit: `${S}/sync.ts#linkTargetRefs`,
        anchor: 'linkTargetRefs',
      }),
      preflight(entry, 'const scope = await routeEmployeeScope(c, deps)'),
      unrestricted(entry, 'guard: async (_tx, admin) => requireUnrestricted(admin)'),
      employeeView([{ ...entry, anchor: 'const scope = await routeEmployeeScope(c, deps)' }], ROUTE_EMPLOYEE_FACTS),
    ],
  },
  // ---- people.ts --------------------------------------------------------------------------------------------------
  {
    file: 'people.ts',
    method: 'GET',
    path: '/people',
    key: 'person',
    need: 'read( c, deps, VIEW',
    needConst: VIEW('people.ts', 'person'),
  },
  {
    file: 'people.ts',
    method: 'GET',
    path: '/people/:id',
    key: 'person',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('people.ts', 'person'),
  },
  {
    file: 'people.ts',
    method: 'GET',
    path: '/people/:id/link-logs',
    key: 'person',
    button: 'sync',
    need: "{ object: 'person', button: BUTTONS.sync }",
    opFact: false,
    extra: (entry) => [unrestricted(entry, 'requireUnrestricted(admin)')],
  },
  {
    file: 'people.ts',
    method: 'POST',
    path: '/people',
    key: 'person',
    operation: 'create',
    button: 'create',
    need: "need: { object: 'person', operation: 'create' }",
    extra: (entry) => [
      resource(entry, 'guard: async (_tx, admin) => requireCreatable(admin)', [
        {
          role: 'impl',
          unit: `${S}/people.ts#requireCreatable`,
          anchor:
            "if (admin.people) fail('FORBIDDEN', '开启精细化权限后只能选择可见的人员，不能新建人员', 'PERSON_NOT_AVAILABLE')",
        },
      ]),
      refs(
        entry,
        'refs: (tx, admin, input) => requireSuperior(tx, input.superiorPersonId, undefined, admin)',
        REQUIRE_SUPERIOR,
      ),
    ],
  },
  {
    file: 'people.ts',
    method: 'PUT',
    path: '/people/:id',
    key: 'person',
    operation: 'update',
    button: 'update',
    need: "need: { object: 'person', operation: 'update' }",
    extra: (entry) => [
      resource(entry, 'guard: async (tx, admin) => void (await visiblePerson(tx, admin, id))', [
        {
          role: 'impl',
          unit: `${S}/people.ts#visiblePerson`,
          anchor: "if (!(await personVisible(tx, admin, person))) fail('NOT_FOUND', message)",
        },
      ]),
      refs(
        entry,
        'requireSuperior(tx, input.superiorPersonId, id, admin, (await loadPerson(tx, id)).superiorPersonId)',
        REQUIRE_SUPERIOR,
      ),
    ],
  },
  // ---- questionnaires.ts ------------------------------------------------------------------------------------------
  {
    file: 'questionnaires.ts',
    method: 'GET',
    path: '/questionnaires',
    key: 'questionnaire',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('questionnaires.ts', 'questionnaire'),
  },
  {
    file: 'questionnaires.ts',
    method: 'GET',
    path: '/questionnaires/:id',
    key: 'questionnaire',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('questionnaires.ts', 'questionnaire'),
  },
  {
    file: 'questionnaires.ts',
    method: 'POST',
    path: '/questionnaires',
    key: 'questionnaire',
    operation: 'create',
    button: 'create',
    need: "need: { object: 'questionnaire', operation: 'create' }",
  },
  {
    file: 'questionnaires.ts',
    method: 'PUT',
    path: '/questionnaires/:id',
    key: 'questionnaire',
    operation: 'update',
    button: 'update',
    need: "need: { object: 'questionnaire', operation: 'update' }",
    extra: (entry) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id)'),
  },
  {
    file: 'questionnaires.ts',
    method: 'POST',
    path: '/questionnaires/:id/enable',
    key: 'questionnaire',
    operation: 'update',
    button: 'enable',
    need: "need: { object: 'questionnaire', operation: 'update', button: 'enable' }",
    extra: (entry) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id)'),
  },
  {
    file: 'questionnaires.ts',
    method: 'DELETE',
    path: '/questionnaires/:id',
    key: 'questionnaire',
    operation: 'delete',
    button: 'delete',
    need: "need: { object: 'questionnaire', operation: 'delete' }",
    extra: (entry) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id, true)'),
  },
  // ---- activities.ts ----------------------------------------------------------------------------------------------
  {
    file: 'activities.ts',
    method: 'GET',
    path: '/activities',
    key: 'activity',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('activities.ts', 'activity'),
  },
  {
    file: 'activities.ts',
    method: 'GET',
    path: '/activities/:id',
    key: 'activity',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('activities.ts', 'activity'),
  },
  {
    file: 'activities.ts',
    method: 'POST',
    path: '/activities',
    key: 'activity',
    operation: 'create',
    button: 'create',
    need: "need: { object: 'activity', operation: 'create' }",
  },
  {
    file: 'activities.ts',
    method: 'PUT',
    path: '/activities/:id',
    key: 'activity',
    operation: 'update',
    button: 'update',
    need: "need: { object: 'activity', operation: 'update' }",
    extra: (entry) => [activityGuard(entry)],
  },
  {
    file: 'activities.ts',
    method: 'DELETE',
    path: '/activities/:id',
    key: 'activity',
    operation: 'delete',
    button: 'delete',
    need: "need: { object: 'activity', operation: 'delete' }",
    extra: (entry) => [
      resource(entry, 'guard: deletable(id)', [
        {
          role: 'impl',
          unit: `${S}/activities.ts#deletable`,
          anchor: 'void (await requireActivity(tx, admin, id, false, true))',
        },
        REQUIRE_ACTIVITY,
      ]),
    ],
  },
  ...(['enable', 'disable'] as const).map((action): Route => ({
    file: 'activities.ts',
    method: 'POST',
    path: `/activities/:id/${action}`,
    key: 'activity',
    operation: 'update',
    button: action,
    need: "need: { object: 'activity', operation: 'update', button: action }",
    extra: (entry) => [activityGuard(entry)],
  })),
  {
    file: 'activities.ts',
    method: 'GET',
    path: '/activities/:id/objects/:objectId/scores',
    key: 'result',
    need: "read(c, deps, { object: 'result' }",
    opFact: false,
  },
  {
    file: 'activities.ts',
    method: 'GET',
    path: '/activities/:id/grants',
    key: 'activity',
    need: 'read( c, deps, VIEW',
    needConst: VIEW('activities.ts', 'activity'),
  },
  ...(['POST /activities/:id/grants', 'DELETE /activities/:id/grants/:userId'] as const).map((key): Route => {
    const [method, path] = key.split(' ') as ['POST' | 'DELETE', string];
    return {
      file: 'activities.ts',
      method,
      path,
      key: 'activity',
      operation: 'update',
      button: 'update',
      need: 'need: EDIT',
      needConst: EDIT_NEED,
      extra: (entry) => [activityGuard(entry)],
    };
  }),
  // ---- relations.ts -----------------------------------------------------------------------------------------------
  {
    file: 'relations.ts',
    method: 'GET',
    path: '/activities/:id/objects',
    key: 'relation',
    need: 'read( c, deps, VIEW',
    needConst: VIEW('relations.ts', 'relation'),
  },
  {
    file: 'relations.ts',
    method: 'POST',
    path: '/activities/:id/objects',
    key: 'relation',
    operation: 'create',
    button: 'create',
    need: "need: { object: 'relation', operation: 'create' }",
    extra: (entry) => [
      activityGuard(entry),
      refs(entry, 'refs: personRefs', PERSON_REFS),
      ...also(entry, 'also: personAlso', ['create'], PERSON_ALSO),
    ],
  },
  {
    file: 'relations.ts',
    method: 'PUT',
    path: '/activities/:id/objects/:objectId/questionnaires',
    key: 'relation',
    operation: 'update',
    button: 'update',
    need: "need: { object: 'relation', operation: 'update' }",
    extra: (entry) => [objectGuard(entry)],
  },
  {
    file: 'relations.ts',
    method: 'DELETE',
    path: '/activities/:id/objects/:objectId',
    key: 'relation',
    operation: 'delete',
    button: 'delete',
    need: "need: { object: 'relation', operation: 'delete' }",
    extra: (entry) => [objectGuard(entry, 'guard: objectGuard(id, objectId, true)')],
  },
  {
    file: 'relations.ts',
    method: 'GET',
    path: '/activities/:id/objects/:objectId/appraisers',
    key: 'relation',
    need: 'read( c, deps, VIEW',
    needConst: VIEW('relations.ts', 'relation'),
  },
  {
    file: 'relations.ts',
    method: 'POST',
    path: '/activities/:id/objects/:objectId/appraisers',
    key: 'relation',
    operation: 'create',
    button: 'create',
    need: "need: { object: 'relation', operation: 'create' }",
    extra: (entry) => [
      objectGuard(entry),
      refs(entry, 'refs: personRefs', PERSON_REFS),
      ...also(entry, 'also: personAlso', ['create'], PERSON_ALSO),
    ],
  },
  {
    file: 'relations.ts',
    method: 'DELETE',
    path: '/activities/:id/objects/:objectId/appraisers/:relationId',
    key: 'relation',
    operation: 'delete',
    button: 'delete',
    need: "need: { object: 'relation', operation: 'delete' }",
    extra: (entry) => [objectGuard(entry, 'await objectGuard(id, objectId, true)(tx, admin)')],
  },
  {
    file: 'relations.ts',
    method: 'POST',
    path: '/activities/:id/objects/:objectId/appraisers/auto',
    key: 'relation',
    operation: 'create',
    button: 'autoAdd',
    need: "need: { object: 'relation', operation: 'create', button: 'autoAdd' }",
    extra: (entry) => [
      objectGuard(entry),
      ...also(
        entry,
        "also: () => [{ need: { object: 'person', operation: 'create' }, fields: SYNCED_PERSON_FIELDS }]",
        ['create'],
      ),
      preflight(entry, 'employees = await routeEmployeeScope(c, deps)'),
      employeeView([{ ...entry, anchor: 'employees = await routeEmployeeScope(c, deps)' }], ROUTE_EMPLOYEE_FACTS),
    ],
  },
  {
    file: 'relations.ts',
    method: 'POST',
    path: '/activities/:id/appraisers/import',
    key: 'relation',
    operation: 'create',
    button: 'import',
    need: "need: { object: 'relation', operation: 'create', button: 'import' }",
    extra: (entry) => {
      const sync = 'if (body?.sync === true) await routeEmployeeScope(c, deps)';
      return [
        activityGuard(entry),
        refs(entry, 'refs: importRefs(id)', {
          role: 'impl',
          unit: `${S}/relations.ts#importRefs`,
          anchor: 'importRefs',
        }),
        ...also(entry, 'also: importAlso', ['create', 'update'], IMPORT_ALSO),
        preflight(entry, 'preflight: async () => {'),
        {
          perm: 'guard:survey360.syncEmployees',
          facts: ['guard:survey360.syncEmployees'],
          at: [{ ...entry, anchor: sync }],
        },
        {
          ...employeeView(
            [
              { ...entry, anchor: sync },
              { ...entry, anchor: '(access ??= await syncAccess(tx, deps, ctx))' },
            ],
            ROUTE_EMPLOYEE_FACTS,
          ),
          purpose: 'when:survey360.syncEmployees',
          note: 'body.sync === true 才要求（命令前 preflight 与命令内 syncAccess 同一条件）',
        },
      ];
    },
  },
  {
    file: 'relations.ts',
    method: 'POST',
    path: '/activities/:id/objects/:objectId/confirmation',
    key: 'relation',
    operation: 'update',
    button: 'invite',
    need: "need: { object: 'relation', operation: 'update', button: 'invite' }",
    extra: (entry) => [objectGuard(entry)],
  },
];

// ---- 作答 / 确认链接（answering.ts）：令牌守卫在每个处理函数里 -----------------------------------------------------
const ANSWERING = `${S}/answering.ts`;
const LINK_TOKEN: Evidence[] = [
  {
    role: 'impl',
    unit: `${ANSWERING}#linkTenant`,
    anchor: 'if (!tenantId || !isUuid(tenantId) || !token || token.length > 200) notFound()',
  },
  {
    role: 'impl',
    unit: `${ANSWERING}#resolve`,
    anchor: 'if (!link || (kind !== undefined && link.kind !== kind)) notFound()',
  },
];
const LINK_READ: Evidence = {
  role: 'impl',
  unit: `${ANSWERING}#linkRead`,
  anchor: 'const { link, activity } = await resolve(tx, token, kind)',
};
const LINK_WRITE: Evidence = {
  role: 'impl',
  unit: `${ANSWERING}#linkWrite`,
  anchor: 'const current = await resolve(tx, token, kind)',
};
const LINKS: readonly [string, string, string][] = [
  ['GET', '/', 'linkRead(deps, undefined'],
  ['GET', '/avatars/:attachmentId/content', 'linkRead( deps, undefined'],
  ['GET', '/tasks/:relationId/questionnaires/:questionnaireId', "linkRead(deps, 'answer'"],
  ['PUT', '/tasks/:relationId/questionnaires/:questionnaireId', "return linkWrite( deps, 'answer'"],
  ['POST', '/tasks/:relationId/questionnaires/:questionnaireId/submit', "return linkWrite( deps, 'answer'"],
  ['GET', '/confirmation/candidates', "linkRead(deps, 'confirm'"],
  ['POST', '/confirmation/appraisers', "linkWrite( deps, 'confirm'"],
  ['DELETE', '/confirmation/appraisers/:relationId', "return linkWrite( deps, 'confirm'"],
  ['POST', '/confirmation/submit', "linkWrite(deps, 'confirm'"],
];

export const SURVEY360: RequiredTable = {
  ...Object.fromEntries(ROUTES.map((r) => [`${r.method} ${BASE}${r.path}`, obligations(r)])),
  ...Object.fromEntries(
    LINKS.map(([method, path, anchor]) => [
      `${method} /api/survey360/link${path === '/' ? '' : path}`,
      [
        {
          perm: 'guard:survey360.linkToken',
          note: '外部评价者凭链接令牌访问，不经成员中间件（DEC-280 / DEC-291 Q2）',
          at: [
            call(`${ANSWERING}#route:${method} ${path}`, anchor),
            method === 'GET' ? LINK_READ : LINK_WRITE,
            ...LINK_TOKEN,
          ],
        },
      ],
    ]),
  ),
};
