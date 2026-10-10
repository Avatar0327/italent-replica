/**
 * 必需项表：人才评定配置（modules/evaluation/routes.ts；R3-T02 PR-B B1a 活动类型）。
 * 对象操作经 access.evaluationContext → module-route-access.objectContext（对象编码 EVALUATION_OBJECTS[对象].code）；
 * 写入口另经 evaluationWriteContext 叠加按钮（BUTTON_LEVEL）。对象的增删改查由 registerObject 按 SPECS 注册
 * （路径由 spec.path 拼出，证据绑注册函数 + SPECS 常量）。写入口的写字段权（checkWriteFields）随数据操作义务承接。活动类型是字典，没有被引用对象、所属管理单元与连带删除的子对象；被引用拒删的钩子位
 * （usage.ts）由 B4 / B5 登记引用方，登记时在各自的表项里补守卫。后续子 PR（B1b、B3～B6）在本文件追加各自对象的表项。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/evaluation';
const EV = 'apps/api/src/modules/evaluation';
const ROUTES = `${EV}/routes.ts`;
const ACCESS = `${EV}/access.ts`;
const MRA = 'apps/api/src/modules/permission/module-route-access.ts';
const CATALOG = 'packages/domain/src/evaluation/catalog.ts#EVALUATION_OBJECTS';

type Key = 'activityType';
/** 对象 → [编码后缀, 路径, 目录里的定义片段]。 */
const OBJECTS: Readonly<Record<Key, readonly [string, string, string]>> = {
  activityType: ['ActivityType', 'activity-types', "activityType: object('ActivityType'"],
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
const registered = (entry: keyof typeof REGISTER) => call(`${ROUTES}#registerObject`, REGISTER[entry]);
const spec = (key: Key): Evidence[] => [
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
    call(`${ROUTES}#registerObject`, 'requireFilterVisible(fields, field)'),
    impl(
      `${ACCESS}#requireFilterVisible`,
      "throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', field })",
    ),
    specRefs(`${key}: { object: '${key}', path: '${OBJECTS[key][1]}'`),
  ],
});

function crud(key: Key): RequiredTable {
  const path = `${BASE}/${OBJECTS[key][1]}`;
  const op = (operation: 'create' | 'update' | 'delete') => writeOp(key, operation, registered(operation), spec(key));
  return {
    [`GET ${path}`]: [view(key, registered('list'), spec(key)), filterFieldVisible(key)],
    [`GET ${path}/:id`]: [view(key, registered('detail'), spec(key))],
    [`POST ${path}`]: op('create'),
    [`PATCH ${path}/:id`]: op('update'),
    [`DELETE ${path}/:id`]: op('delete'),
  };
}

export const EVALUATION: RequiredTable = {
  ...crud('activityType'),
};
