/**
 * 必需项表：调动电子签署配置（modules/esign/routes.ts，F-481 S1；设计 §10）。对象操作经 module-route-access.objectContext
 * （配置对象 TenantBase.ESignSettings，只有数据操作开关，无按钮与范围）；写入字段权经 writeFields；写命令的事务内复核
 * 由 write() 的 guard.before 再按当前权限复核一次。模板下拉与发起调动同一授权：任职对象新增 + Transfer.Hr 按钮（button）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const BASE = '/api/tenant/esign';
const ROUTES = 'apps/api/src/modules/esign/routes.ts';
const ACCESS = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJ = 'TenantBase.ESignSettings';
const RECORD = 'TenantBase.EmploymentRecord';

const OBJECT_CONST: Evidence[] = [
  { role: 'const', unit: `${ROUTES}#OBJECT`, anchor: 'MODULE_OBJECTS.eSignSettings.code' },
  {
    role: 'const',
    unit: 'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS>eSignSettings',
    anchor: "object( 'ESignSettings'",
  },
];
const RECORD_CONST: Evidence[] = [
  {
    role: 'const',
    unit: 'apps/api/src/modules/employment/context.ts#EMPLOYMENT_OBJECT',
    anchor: "'TenantBase.EmploymentRecord'",
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
const call = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} ${BASE}${path}`,
  anchor,
});

function view(path: string): Obligation {
  return {
    perm: `obj:${OBJ}:view`,
    facts: ['object:objectContext', `objectOp:${OBJ}:view`],
    at: [call('GET', path, "const ctx = await objectContext(c, deps, OBJECT, 'view')"), CONTEXT, ...OBJECT_CONST],
  };
}
function write(method: string, path: string, operation: 'create' | 'update'): Obligation {
  const open = `await objectContext(c, deps, OBJECT, '${operation}')`;
  return {
    perm: `obj:${OBJ}:${operation}`,
    facts: ['object:objectContext', `objectOp:${OBJ}:${operation}`],
    at: [
      call(method, path, `const ${operation === 'create' ? 'ctx' : 'base'} = ${open}`),
      CONTEXT,
      call(method, path, `await writeFields(deps, ctx, OBJECT, '${operation}', input)`),
      WRITE_FIELDS,
      ...OBJECT_CONST,
    ],
  };
}

const OPTIONS = '/template-options/transfer-form';
const optionsCall = (anchor: string) => call('GET', OPTIONS, anchor);

export const ESIGN: RequiredTable = {
  [`GET ${BASE}/templates`]: [view('/templates')],
  [`POST ${BASE}/templates`]: [write('POST', '/templates', 'create')],
  [`PATCH ${BASE}/templates/:id`]: [write('PATCH', '/templates/:id', 'update')],
  [`GET ${BASE}/scenes/transfer`]: [view('/scenes/transfer')],
  [`PUT ${BASE}/scenes/transfer`]: [write('PUT', '/scenes/transfer', 'update')],
  [`GET ${BASE}${OPTIONS}`]: [
    {
      perm: `obj:${RECORD}:create`,
      facts: ['object:objectContext', `objectOp:${RECORD}:create`],
      at: [
        optionsCall("const ctx = await objectContext(c, deps, EMPLOYMENT_OBJECT, 'create')"),
        CONTEXT,
        ...RECORD_CONST,
      ],
    },
    {
      perm: `btn:${RECORD}#Transfer.Hr@detail`,
      facts: ['button:button()'],
      at: [
        optionsCall("await button(deps, ctx, EMPLOYMENT_OBJECT, TRANSFER_HR_BUTTON, 'detail')"),
        BUTTON,
        ...RECORD_CONST,
      ],
    },
  ],
};
