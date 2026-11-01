/**
 * 必需项表：职责转交菜单（modules/duty-transfer/routes.ts，R2-T09a；DEC-602② / DEC-726）。对象操作经
 * module-route-access.objectContext（对象 TenantBase.DutyTransferCommon）；按钮经 button；写入字段权经 writeFields。
 * 单人入口的被转交人经 requireVisiblePerson 按同一对象的数据范围判定（守卫 dutyTransfer.person，范围外与不存在同为 404）；
 * 提交在命令事务内按当前范围复核（runCommand 的 before / replayed）；
 * 接收人同样按该范围判定（requireVisibleReceivers）。两个列表在 SQL 内叠加范围谓词（requestScope + scopeSql）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/duty-transfers';
const PEOPLE = `${BASE}/people/:id`;
const ROUTES = 'apps/api/src/modules/duty-transfer/routes.ts';
const ACCESS = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJ = 'TenantBase.DutyTransferCommon';
const BUTTON_CODE = 'SetDutyTransferReceiver';

const OBJECT_CONST: Evidence[] = [
  { role: 'const', unit: `${ROUTES}#OBJECT`, anchor: 'DUTY_TRANSFER_OBJECT' },
  {
    role: 'const',
    unit: 'packages/domain/src/employment/duty-transfer-menu.ts#DUTY_TRANSFER_OBJECT',
    anchor: `'${OBJ}'`,
  },
];
const CONTEXT: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#objectContext`,
  anchor:
    'await requirePermission(deps.authorize, { ...ctx, action: ' +
    '`object.${operation}`, resource: objectCode, fields: [] })',
};
const BUTTON: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#button`,
  anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
};
const WRITE_FIELDS: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#writeFields`,
  anchor: 'await requireObjectWrite(deps.authorize, ctx, {',
};
const VISIBLE_PERSON: Evidence = {
  role: 'impl',
  unit: `${ROUTES}#requireVisiblePerson`,
  anchor: "if (!(await personVisible(tx, tenantId, scope, employeeId))) throw new AppError('NOT_FOUND', '员工不存在')",
};
const SERVICE = 'apps/api/src/modules/duty-transfer/service.ts';
const call = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} ${path}`,
  anchor,
});

function op(method: string, path: string, operation: 'view' | 'create', anchor: string): Obligation {
  return {
    perm: `obj:${OBJ}:${operation}`,
    facts: ['object:objectContext', `objectOp:${OBJ}:${operation}`],
    at: [call(method, path, anchor), CONTEXT, ...OBJECT_CONST],
  };
}
const view = (path: string) => op('GET', path, 'view', "const ctx = await objectContext(c, deps, OBJECT, 'view')");
const setReceiver = (path: string): Obligation => ({
  perm: `btn:${OBJ}#${BUTTON_CODE}@list`,
  facts: ['button:button()'],
  at: [
    call('POST', path, "await button(deps, ctx, OBJECT, DUTY_TRANSFER_SET_RECEIVER_BUTTON, 'list')"),
    BUTTON,
    ...OBJECT_CONST,
    {
      role: 'const',
      unit: 'packages/domain/src/employment/duty-transfer-menu.ts#DUTY_TRANSFER_SET_RECEIVER_BUTTON',
      anchor: `'${BUTTON_CODE}'`,
    },
  ],
});
const person = (method: string, path: string, anchor: string): Obligation => ({
  perm: 'guard:dutyTransfer.person',
  facts: ['guard:dutyTransfer.person'],
  at: [call(method, path, anchor), VISIBLE_PERSON],
});

/** 下属职责改写其当前任职的上级：按 DEC-178 联动范围复核（不可见整单拒绝），与离职内转交同口径。 */
const LINKAGE: Obligation = {
  perm: 'guard:employment.linkage',
  facts: ['guard:employment.linkage'],
  note: 'DEC-178：下属转交改写下属当前任职前按任职范围复核',
  at: [
    call('POST', PEOPLE, 'await submitMenuTransfer(tx, { ...ctx, commandId }, employeeId, input, access)'),
    {
      role: 'impl',
      unit: `${SERVICE}#submitMenuTransfer`,
      anchor: 'await authorizeDuty(tx, ctx, access, duty, today)',
    },
    { role: 'impl', unit: `${SERVICE}#authorizeDuty`, anchor: 'await requireLinkedEmploymentRecord(' },
  ],
};

export const DUTY_TRANSFER: RequiredTable = {
  [`GET ${PEOPLE}/duties`]: [
    view(`${PEOPLE}/duties`),
    person('GET', `${PEOPLE}/duties`, 'await requireVisiblePerson(tx, ctx.tenantId, scope, employeeId)'),
  ],
  [`POST ${PEOPLE}/check`]: [
    op('POST', `${PEOPLE}/check`, 'create', "const ctx = await objectContext(c, deps, OBJECT, 'create')"),
    setReceiver(`${PEOPLE}/check`),
    person('POST', `${PEOPLE}/check`, 'await requireVisiblePerson(tx, ctx.tenantId, scope, employeeId)'),
  ],
  [`POST ${PEOPLE}`]: [
    {
      ...op('POST', PEOPLE, 'create', "const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c))"),
      facts: ['object:objectContext', `objectOp:${OBJ}:create`, 'object:requireObjectWrite（对象写操作权）'],
      at: [
        call('POST', PEOPLE, "const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c))"),
        CONTEXT,
        call(
          'POST',
          PEOPLE,
          "await writeFields(deps, ctx, OBJECT, 'create', { receiverId: null, transferDate: null })",
        ),
        WRITE_FIELDS,
        ...OBJECT_CONST,
      ],
    },
    setReceiver(PEOPLE),
    LINKAGE,
    person('POST', PEOPLE, 'await requireVisiblePerson(tx, ctx.tenantId, scope, employeeId)'),
  ],
  [`GET ${BASE}/records`]: [view(`${BASE}/records`)],
  [`GET ${BASE}/departed`]: [view(`${BASE}/departed`)],
};
