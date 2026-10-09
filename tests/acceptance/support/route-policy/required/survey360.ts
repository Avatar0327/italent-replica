/**
 * 必需项表：360 度评估管理端（modules/survey360/*.ts，挂在 /api/tenant/survey360 子应用）与作答 / 确认链接
 * （answering.ts，挂在 /api/survey360/link）。管理端每个路由经 context.read / write → routeNeed：objectContext
 * （对象.操作）+ 按钮（显式按钮，或对象目录里与操作同名的按钮，buttonOf），命令事务内 requireNeed 按同一对象 / 按钮
 * 重验；资源守卫（options.guard）、载荷引用（refs）、隐式写入的人员（also → routeNeed）、命令前员工信息查看权
 * （preflight → routeEmployeeScope）逐个绑判定处。链接入口不经成员中间件，令牌在每个处理函数里解析（linkTenant + resolve）。
 */
import { type Binding, bound, list, point, SCOPE_AT, withNeeds } from './scopes.js';
import type { Evidence, Inner, Obligation, RequiredTable } from './types.js';

const S = 'apps/api/src/modules/survey360';
const CONTEXT = `${S}/context.ts`;
const CATALOG = 'packages/domain/src/survey360/catalog.ts';
const BASE = '/api/tenant/survey360';
const EMPLOYEE = 'TenantBase.EmployeeInformation';

type Key = 'activity' | 'relation' | 'result' | 'answer' | 'questionnaire' | 'person' | 'settings';
type Operation = 'view' | 'create' | 'update' | 'delete';
const NAMES: Readonly<Record<Key, string>> = {
  activity: 'Activity',
  relation: 'Relation',
  result: 'Result',
  answer: 'Answer',
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
  block: "button('block', 'detail', 'update')",
  reanswer: "button('reanswer', 'detail', 'update')",
  generateReport: "button('generateReport', 'list', 'update')",
  forwardReport: "button('forwardReport', 'list', 'update')",
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
  block: 'detail',
  reanswer: 'detail',
  generateReport: 'list',
  forwardReport: 'list',
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
  /** POST 的只读接口（read()，如转发预览）：不经 write / 命令事务。 */
  readonly readOnly?: boolean;
  readonly extra?: (entry: Evidence) => Obligation[];
  /** 范围绑定（B-03）：含多个承载节点的备选里 obj: 准入义务按权限键登记 need。 */
  readonly needs?: Readonly<Record<string, Binding>>;
}

const unitOf = (r: Pick<Route, 'file' | 'method' | 'path'>) => `${S}/${r.file}#route:${r.method} ${r.path}`;

function obligations(r: Route): Obligation[] {
  const operation = r.operation ?? 'view';
  const entry = call(unitOf(r), r.need);
  const write = !r.readOnly && (operation !== 'view' || r.method !== 'GET');
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
  const all = [...out, ...(r.extra?.(entry) ?? [])];
  return r.needs ? withNeeds(all, r.needs) : all;
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
/** 创建人本人直接放行，非创建人才判 editOthers（editableBy：row.createdBy === admin.userId 即 return）。 */
const NOT_CREATOR: Inner = { role: 'when', condition: 'questionnaire.notCreatedBySelf' };
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
      inner: NOT_CREATOR,
      note: '本人创建的套卷不要求该按钮',
      at: [{ ...entry, anchor }, impl, buttonConst('questionnaire', 'editOthers')],
    },
    {
      perm: `obj:${code('questionnaire')}:update`,
      purpose: 'guard:survey360.resourceGuard',
      inner: NOT_CREATOR,
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
/** 录入 person 才隐式新建人员（personAlso：ref.person 为空则无 also）。 */
const PAYLOAD_PERSON = (): Inner => ({ role: 'when', condition: 'payload.person' });
/** 导入：新建始终判；选择“同步”时只新建，不同步才另判更新（importAlso）。 */
const IMPORT_INNER = (operation: 'create' | 'update'): Inner =>
  operation === 'create' ? { role: 'required' } : { role: 'when', condition: 'import.notSync' };
/** 隐式写入的 360 人员：also → routeFields → routeNeed（人员的数据操作 + 同名按钮 + 字段），命令事务内 requireNeed 重验。 */
function also(
  entry: Evidence,
  anchor: string,
  operations: readonly ('create' | 'update')[],
  inner: (operation: 'create' | 'update') => Inner,
  impl?: Evidence,
) {
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
        inner: inner(operation),
        at: [...at, ROUTE_NEED, objectConst('person')],
      },
      {
        perm: `btn:${code('person')}#${operation}@${LEVELS[operation]}`,
        purpose: 'guard:survey360.alsoObjects',
        inner: inner(operation),
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
/** 人员同步三个入口：360 人员按 personScope 过滤，员工信息按 employeeScope 过滤。 */
const PEOPLE_SYNC_NEEDS: Readonly<Record<string, Binding>> = {
  'obj:Survey360.Person:view': bound(list('survey360.personScope'), SCOPE_AT['survey360.personScope']),
  [`obj:${EMPLOYEE}:view`]: bound(list('survey360.employeeScope'), SCOPE_AT['survey360.employeeScope']),
};

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
    needs: PEOPLE_SYNC_NEEDS,
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
    needs: PEOPLE_SYNC_NEEDS,
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
    needs: PEOPLE_SYNC_NEEDS,
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
    extra: (entry) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id, false, template)'),
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
    extra: (entry) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id, true, template)'),
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
      ...also(entry, 'also: personAlso', ['create'], PAYLOAD_PERSON, PERSON_ALSO),
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
      ...also(entry, 'also: personAlso', ['create'], PAYLOAD_PERSON, PERSON_ALSO),
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
    needs: {
      'obj:Survey360.Relation:create': bound(point('survey360.object.byId'), SCOPE_AT['survey360.object.byId']),
      [`obj:${EMPLOYEE}:view`]: bound(list('survey360.employeeScope'), SCOPE_AT['survey360.employeeScope(auto)']),
    },
    need: "need: { object: 'relation', operation: 'create', button: 'autoAdd' }",
    extra: (entry) => [
      objectGuard(entry),
      ...also(
        entry,
        "also: () => [{ need: { object: 'person', operation: 'create' }, fields: SYNCED_PERSON_FIELDS }]",
        ['create'],
        () => ({ role: 'required' }),
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
        ...also(entry, 'also: importAlso', ['create', 'update'], IMPORT_INNER, IMPORT_ALSO),
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

// ---- PR-B（docs/08_设计/R3-T03_360度评估PR-B_路由声明.md）----------------------------------------------------------
const VISIBLE_RELATION: Evidence = {
  role: 'impl',
  unit: `${S}/progress.ts#visibleRelation`,
  anchor: "if (!state) fail('NOT_FOUND', '评价关系不存在')",
};
const VISIBLE_SHEET: Evidence = {
  role: 'impl',
  unit: `${S}/sheets.ts#visibleSheet`,
  anchor: "if (!sheet) fail('NOT_FOUND', '答卷不存在')",
};
/** DEC-358②：逐份卡片的查看人（持“全部活动”或活动创建者，兼任者除外）。 */
const sheetCards = (calls: readonly Evidence[]): Obligation => ({
  perm: 'guard:survey360.sheetCards',
  note: '逐份答卷卡片只给持“全部活动”者或活动创建者，兼任被评价人 / 评价者除外（DEC-358②）',
  at: [
    ...calls,
    {
      role: 'impl',
      unit: `${S}/anonymous.ts#requireCardViewer`,
      anchor: "fail('FORBIDDEN', '只有持“全部活动”权限的管理员或活动创建者可以查看逐份答卷', 'SHEET_CARDS_RESTRICTED')",
    },
    // 匿名投影层（DEC-364①）：卡片与审计出口共用的查看人谓词
    { role: 'impl', unit: `${S}/anonymous.ts#cardViewer`, anchor: 'participates(viewer.userId)' },
  ],
});
const INVITE_NEED: Evidence = {
  role: 'const',
  unit: `${S}/todos.ts#registerTodoRoutes>INVITE`,
  anchor: "{ object: 'relation', operation: 'update', button: 'invite' }",
};
const BLOCK_NEED: Evidence = {
  role: 'const',
  unit: `${S}/sheets.ts#BLOCK`,
  anchor: "{ object: 'answer', operation: 'update', button: 'block' }",
};
/** 报告生成 / 转发共用的命令处理函数（reports.ts command 工厂）：need 的按钮来自注册处实参。 */
const REPORT_COMMAND: Evidence = {
  role: 'impl',
  unit: `${S}/reports.ts#registerReportRoutes>command`,
  anchor: "need: { object: 'result', operation: 'update', button }",
};
const REPORT_COMMAND_GUARD: Evidence = {
  role: 'impl',
  unit: `${S}/reports.ts#registerReportRoutes>command`,
  anchor: 'await requireActivity(tx, admin, id)',
};
const FULL_REPORT_IMPL: Evidence = {
  role: 'impl',
  unit: `${S}/reports.ts#requireFullReportView`,
  anchor: "fail('FORBIDDEN', '对报告内容没有完整的查看权限，不能转发', 'REPORT_FIELDS_RESTRICTED')",
};
const fullReport = (calls: readonly Evidence[]): Obligation => ({
  perm: 'guard:survey360.fullReportView',
  note: '转发与预览另要对报告正文涉及的全部结果字段有查看权（第 2 轮 P2-5）',
  at: [...calls, FULL_REPORT_IMPL],
});
const ACTIVITY_GUARD = 'guard: async (tx, admin) => void (await requireActivity(tx, admin, id))';
const LOAD_SOURCE: Evidence = {
  role: 'impl',
  unit: `${S}/questionnaires.ts#questionnaireRow`,
  anchor: "if (!row) fail('NOT_FOUND', template ? '套卷模板不存在' : '套卷不存在')",
};
/** 套卷模板与套卷共用同一套处理函数（questionnaires.ts for…of [QUESTIONNAIRES, TEMPLATES]）。 */
function templateRoutes(): Route[] {
  const base = '/questionnaire-templates';
  const routes: Omit<Route, 'file' | 'key'>[] = [
    { method: 'GET', path: base, need: 'read(c, deps, VIEW', needConst: VIEW('questionnaires.ts', 'questionnaire') },
    {
      method: 'GET',
      path: `${base}/:id`,
      need: 'read(c, deps, VIEW',
      needConst: VIEW('questionnaires.ts', 'questionnaire'),
    },
    {
      method: 'POST',
      path: base,
      operation: 'create',
      button: 'create',
      need: "need: { object: 'questionnaire', operation: 'create' }",
    },
    {
      method: 'PUT',
      path: `${base}/:id`,
      operation: 'update',
      button: 'update',
      need: "need: { object: 'questionnaire', operation: 'update' }",
      extra: (entry: Evidence) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id, false, template)'),
    },
    {
      method: 'DELETE',
      path: `${base}/:id`,
      operation: 'delete',
      button: 'delete',
      need: "need: { object: 'questionnaire', operation: 'delete' }",
      extra: (entry: Evidence) => editableBy(entry, 'guard: editableBy(deps, tenantOf(c), id, true, template)'),
    },
    ...['/questionnaires/:id/save-as-template', `${base}/:id/instantiate`].map((path) => ({
      method: 'POST' as const,
      path,
      operation: 'create' as const,
      button: 'create',
      need: "need: { object: 'questionnaire', operation: 'create' }",
      extra: (entry: Evidence) => [
        resource(entry, 'guard: async (tx) => void (await loadQuestionnaire(tx, id, false, fromTemplate))', [
          LOAD_SOURCE,
        ]),
      ],
    })),
  ];
  return routes.map((r) => ({ file: 'questionnaires.ts', key: 'questionnaire' as const, ...r }));
}

const PR_B_ROUTES: readonly Route[] = [
  // progress.ts
  {
    file: 'progress.ts',
    method: 'GET',
    path: '/activities/:id/progress',
    key: 'relation',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('progress.ts', 'relation'),
  },
  {
    file: 'progress.ts',
    method: 'GET',
    path: '/activities/:id/progress/:personId',
    key: 'relation',
    need: 'read( c, deps, VIEW',
    needConst: VIEW('progress.ts', 'relation'),
  },
  {
    file: 'progress.ts',
    method: 'POST',
    path: '/activities/:id/relations/:relationId/reanswer',
    key: 'answer',
    operation: 'update',
    button: 'reanswer',
    need: "need: { object: 'answer', operation: 'update', button: 'reanswer' }",
    extra: (entry) => [
      resource(entry, 'await visibleRelation(tx, (await requireActivity(tx, admin, id)).id, admin, relationId)', [
        REQUIRE_ACTIVITY,
        VISIBLE_RELATION,
      ]),
    ],
  },
  // todos.ts：发送 / 取消待办、邮件邀请
  ...['/todos', '/todos/cancel', '/invitations'].map((path): Route => ({
    file: 'todos.ts',
    method: 'POST',
    path: `/activities/:id${path}`,
    key: 'relation',
    operation: 'update',
    button: 'invite',
    need: 'need: INVITE',
    needConst: INVITE_NEED,
    extra: (entry) => [resource(entry, ACTIVITY_GUARD, [REQUIRE_ACTIVITY])],
  })),
  // sheets.ts：原始数据、屏蔽 / 取消屏蔽、屏蔽疑似、恢复
  {
    file: 'sheets.ts',
    method: 'GET',
    path: '/activities/:id/sheets',
    key: 'answer',
    need: "read(c, deps, { object: 'answer' }",
    opFact: false,
    extra: (entry) => [sheetCards([{ ...entry, anchor: 'await requireCardViewer(tx, admin, activity)' }])],
  },
  ...['block', 'unblock'].map((action): Route => ({
    file: 'sheets.ts',
    method: 'POST',
    path: `/activities/:id/sheets/:sheetId/${action}`,
    key: 'answer',
    operation: 'update',
    button: 'block',
    need: 'need: BLOCK',
    needConst: BLOCK_NEED,
    extra: (entry) => [
      resource(entry, 'await visibleSheet(tx, activity.id, admin, sheetId)', [REQUIRE_ACTIVITY, VISIBLE_SHEET]),
      sheetCards([
        { ...entry, anchor: 'await requireCardViewer(tx, admin, activity)' },
        { ...entry, anchor: 'await requireCardViewer(tx, ctx.admin, activity)' },
      ]),
    ],
  })),
  ...['block-suspected', 'unblock-all'].map((path): Route => ({
    file: 'sheets.ts',
    method: 'POST',
    path: `/activities/:id/sheets/${path}`,
    key: 'answer',
    operation: 'update',
    button: 'block',
    need: 'need: BLOCK',
    needConst: BLOCK_NEED,
    extra: (entry) => [resource(entry, ACTIVITY_GUARD, [REQUIRE_ACTIVITY])],
  })),
  // reports.ts：报告模板、报告、生成、转发与预览
  {
    file: 'reports.ts',
    method: 'GET',
    path: '/report-template',
    key: 'settings',
    need: "read(c, deps, { object: 'settings' }",
    opFact: false,
  },
  {
    file: 'reports.ts',
    method: 'PUT',
    path: '/report-template',
    key: 'settings',
    operation: 'update',
    button: 'update',
    need: "need: { object: 'settings', operation: 'update' }",
  },
  {
    file: 'reports.ts',
    method: 'GET',
    path: '/activities/:id/reports',
    key: 'result',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('reports.ts', 'result'),
  },
  {
    file: 'reports.ts',
    method: 'GET',
    path: '/activities/:id/reports/:reportId',
    key: 'result',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('reports.ts', 'result'),
  },
  // F-060：下载 PDF 与详情共用 detail，权限 / 范围 / 字段裁剪相同
  {
    file: 'reports.ts',
    method: 'GET',
    path: '/activities/:id/reports/:reportId/download',
    key: 'result',
    need: 'read(c, deps, VIEW',
    needConst: VIEW('reports.ts', 'result'),
  },
  {
    file: 'reports.ts',
    method: 'POST',
    path: '/activities/:id/reports/generate',
    key: 'result',
    operation: 'update',
    button: 'generateReport',
    need: "command( 'generateReport'",
    needConst: REPORT_COMMAND,
    extra: (entry) => [resource(entry, "command( 'generateReport'", [REPORT_COMMAND_GUARD, REQUIRE_ACTIVITY])],
  },
  {
    file: 'reports.ts',
    method: 'POST',
    path: '/activities/:id/reports/forward',
    key: 'result',
    operation: 'update',
    button: 'forwardReport',
    need: "command( 'forwardReport'",
    needConst: REPORT_COMMAND,
    extra: (entry) => [
      resource(entry, "command( 'forwardReport'", [REPORT_COMMAND_GUARD, REQUIRE_ACTIVITY]),
      fullReport([
        { ...entry, anchor: "command( 'forwardReport'" },
        {
          role: 'impl',
          unit: `${S}/reports.ts#registerReportRoutes>command`,
          anchor: 'if (fullView) await requireFullReportView(tx, deps, tenantOf(c))',
        },
      ]),
    ],
  },
  {
    file: 'reports.ts',
    method: 'POST',
    path: '/activities/:id/reports/forward/preview',
    key: 'result',
    button: 'forwardReport',
    readOnly: true,
    need: "read(c, deps, { ...VIEW, button: 'forwardReport' }",
    needConst: VIEW('reports.ts', 'result'),
    extra: (entry) => [fullReport([{ ...entry, anchor: 'await requireFullReportView(tx, deps, tenant)' }])],
  },
  // tables.ts
  {
    file: 'tables.ts',
    method: 'GET',
    path: '/activities/:id/score-tables',
    key: 'result',
    need: "read( c, deps, { object: 'result' }",
    opFact: false,
  },
  // F-060：下载 PNG 与清单共用 scoreTables，权限 / 范围 / 字段裁剪相同
  {
    file: 'tables.ts',
    method: 'GET',
    path: '/activities/:id/score-tables/download',
    key: 'result',
    need: "read( c, deps, { object: 'result' }",
    opFact: false,
  },
  ...templateRoutes(),
];

// ---- 作答 / 确认链接（answering.ts）：令牌守卫在每个处理函数里 -----------------------------------------------------
// PR-B：链接与站内待办两个入口共用作答处理函数（answerRead / answerSave / answerSubmit / avatarRoute），入口由
// entryOf 决定——链接入口为 tokenEntry（linkTenant 解析租户与令牌），待办入口为 todoEntry（本人账号的待办）。
const ANSWERING = `${S}/answering.ts`;
const LINK_TOKEN: Evidence[] = [
  {
    role: 'impl',
    unit: `${ANSWERING}#linkTenant`,
    anchor: 'if (!tenantId || !isUuid(tenantId) || !token || token.length > 200) notFound()',
  },
  { role: 'impl', unit: `${ANSWERING}#tokenEntry`, anchor: 'const { tenant, token } = await linkTenant(c, deps)' },
  {
    role: 'impl',
    unit: `${ANSWERING}#resolve`,
    anchor: 'if (!link || (kind !== undefined && link.kind !== kind)) notFound()',
  },
];
const LINK_READ: Evidence = {
  role: 'impl',
  unit: `${ANSWERING}#linkRead`,
  anchor: 'const { link, activity } = await resolve(tx, entry.locate, kind)',
};
const LINK_WRITE: Evidence = {
  role: 'impl',
  unit: `${ANSWERING}#linkWrite`,
  anchor: 'const current = await resolve(tx, locate, kind)',
};
const LINK_ANSWERS: Evidence = {
  role: 'impl',
  unit: `${ANSWERING}#registerLinkRoutes`,
  anchor: 'registerAnswerRoutes(module, deps, tokenEntry(deps))',
};
const CONFIRM_ENTRY: Evidence = {
  role: 'impl',
  unit: `${ANSWERING}#registerConfirmRoutes`,
  anchor: 'const entryOf = tokenEntry(deps)',
};
const handler = (name: string, anchor: string): Evidence => ({ role: 'impl', unit: `${ANSWERING}#${name}`, anchor });
const TASK = '/tasks/:relationId/questionnaires/:questionnaireId';
const ANSWER_READ = handler('answerRead', "linkRead(deps, entryOf, 'answer'");
const ANSWER_SAVE = handler('answerSave', "return linkWrite( deps, entryOf, 'answer'");
const ANSWER_SUBMIT = handler('answerSubmit', "return linkWrite( deps, entryOf, 'answer'");
const AVATAR = handler('avatarRoute', 'linkRead( deps, entryOf, kind');
const LINKS: readonly [string, string, string, readonly Evidence[]][] = [
  ['GET', '/', 'linkRead(deps, tokenEntry(deps), undefined', []],
  ['GET', '/avatars/:attachmentId/content', 'avatarRoute(deps, tokenEntry(deps), undefined)', [AVATAR]],
  ['GET', TASK, 'answerRead(deps, entryOf)', [LINK_ANSWERS, ANSWER_READ]],
  ['PUT', TASK, 'answerSave(deps, entryOf)', [LINK_ANSWERS, ANSWER_SAVE]],
  ['POST', `${TASK}/submit`, 'answerSubmit(deps, entryOf)', [LINK_ANSWERS, ANSWER_SUBMIT]],
  ['GET', '/confirmation/candidates', "linkRead(deps, entryOf, 'confirm'", [CONFIRM_ENTRY]],
  ['POST', '/confirmation/appraisers', "linkWrite( deps, entryOf, 'confirm'", [CONFIRM_ENTRY]],
  ['DELETE', '/confirmation/appraisers/:relationId', "return linkWrite( deps, entryOf, 'confirm'", [CONFIRM_ENTRY]],
  ['POST', '/confirmation/submit', "linkWrite(deps, entryOf, 'confirm'", [CONFIRM_ENTRY]],
];

// ---- 我的待办与待办作答（todos.ts、answering.ts）：只看 / 只答本人账号的待办 -----------------------------------------
const TODO_ENTRY: Evidence[] = [
  {
    role: 'impl',
    unit: `${S}/routes.ts#registerSurvey360Routes`,
    anchor: 'registerTodoAnswerRoutes(module, deps, todoEntry())',
  },
  { role: 'impl', unit: `${S}/todos.ts#todoEntry`, anchor: 'AND t.user_id =' },
];
const TODO = '/my/todos/:todoId';
const TODO_ANSWERS: readonly [string, string, string, readonly Evidence[]][] = [
  ['GET', `${TODO}/answer`, "linkRead(deps, entryOf, 'answer'", [LINK_READ]],
  ['GET', `${TODO}/avatars/:attachmentId/content`, "avatarRoute(deps, entryOf, 'answer')", [AVATAR, LINK_READ]],
  ['GET', `${TODO}${TASK}`, 'answerRead(deps, entryOf)', [ANSWER_READ, LINK_READ]],
  ['PUT', `${TODO}${TASK}`, 'answerSave(deps, entryOf)', [ANSWER_SAVE, LINK_WRITE]],
  ['POST', `${TODO}${TASK}/submit`, 'answerSubmit(deps, entryOf)', [ANSWER_SUBMIT, LINK_WRITE]],
];
const todoRecipient = (at: readonly Evidence[]): Obligation[] => [
  { perm: 'own:survey360.todoRecipient', note: '本人账号的待办（别人的待办与不存在同一 404）', at },
];

// ---- 报告转发的收件人链接（reports.ts registerReportLinkRoutes）：令牌守卫在每个处理函数里 ----------------------------
const REPORT_LINK = `${S}/reports.ts`;
const REPORT_LINK_TOKEN: Evidence[] = [
  {
    role: 'impl',
    unit: `${REPORT_LINK}#registerReportLinkRoutes>resolve`,
    anchor: "if (!tenantId || !isUuid(tenantId) || !token || token.length > 200) fail('NOT_FOUND', '链接无效或已失效')",
  },
  {
    role: 'impl',
    unit: `${REPORT_LINK}#registerReportLinkRoutes>linkOf`,
    anchor: "if (!link) fail('NOT_FOUND', '链接无效或已失效')",
  },
];
const reportLinkToken = (path: string, extra: readonly string[]): Obligation[] => [
  {
    perm: 'guard:survey360.reportLinkToken',
    note: '收件人凭链接令牌访问，不经成员中间件（与作答链接同口径）',
    at: [
      call(`${REPORT_LINK}#route:GET ${path}`, 'const { tenantId, hash } = await resolve(c)'),
      ...extra.map((anchor) => call(`${REPORT_LINK}#route:GET ${path}`, anchor)),
      ...REPORT_LINK_TOKEN,
    ],
  },
];
// F-060：收件人查看报告与下载 PDF 共用 linked（令牌解析 + 报告须在链接清单里），两个入口各调用一次
const LINKED = `${REPORT_LINK}#registerReportLinkRoutes>linked`;
const reportLinkReport = (path: string): Obligation[] => [
  {
    perm: 'guard:survey360.reportLinkToken',
    note: '收件人凭链接令牌访问，不经成员中间件；报告须在本链接的清单里（linked，查看与下载同一处）',
    at: [
      call(`${REPORT_LINK}#route:GET ${path}`, 'await linked(c)'),
      { role: 'impl', unit: LINKED, anchor: 'const { tenantId, hash } = await resolve(c)' },
      { role: 'impl', unit: LINKED, anchor: "if (!link.reportIds.includes(reportId)) fail('NOT_FOUND', '报告不存在')" },
      ...REPORT_LINK_TOKEN,
    ],
  },
];

export const SURVEY360: RequiredTable = {
  ...Object.fromEntries([...ROUTES, ...PR_B_ROUTES].map((r) => [`${r.method} ${BASE}${r.path}`, obligations(r)])),
  ...Object.fromEntries(
    LINKS.map(([method, path, anchor, impls]) => [
      `${method} /api/survey360/link${path === '/' ? '' : path}`,
      [
        {
          perm: 'guard:survey360.linkToken',
          note: '外部评价者凭链接令牌访问，不经成员中间件（DEC-280 / DEC-291 Q2）',
          at: [
            call(`${ANSWERING}#route:${method} ${path}`, anchor),
            ...impls,
            method === 'GET' ? LINK_READ : LINK_WRITE,
            ...LINK_TOKEN,
          ],
        },
      ],
    ]),
  ),
  [`GET ${BASE}/my/todos`]: todoRecipient([call(`${S}/todos.ts#route:GET /my/todos`, 'WHERE t.user_id =')]),
  ...Object.fromEntries(
    TODO_ANSWERS.map(([method, path, anchor, impls]) => [
      `${method} ${BASE}${path}`,
      todoRecipient([call(`${ANSWERING}#route:${method} ${path}`, anchor), ...impls, ...TODO_ENTRY]),
    ]),
  ),
  'GET /api/survey360/report-link': reportLinkToken('/', []),
  'GET /api/survey360/report-link/reports/:reportId': reportLinkReport('/reports/:reportId'),
  'GET /api/survey360/report-link/reports/:reportId/download': reportLinkReport('/reports/:reportId/download'),
};
