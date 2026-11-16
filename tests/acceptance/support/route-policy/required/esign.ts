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

const RECORD_ROUTES = 'apps/api/src/modules/esign/record-routes.ts';
const RECORD_ACCESS = 'apps/api/src/modules/esign/record-access.ts';
const SIGN_RECORD = 'TenantBase.ESignRecord';
const recordConst: Evidence[] = [
  { role: 'const', unit: `${RECORD_ACCESS}#RECORD_OBJECT`, anchor: 'MODULE_OBJECTS.eSignRecord.code' },
  {
    role: 'const',
    unit: 'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS>eSignRecord',
    anchor: "object('ESignRecord'",
  },
];
const owner: Obligation = {
  perm: 'guard:esign.recordOwner',
  at: [
    {
      role: 'call',
      unit: `${RECORD_ACCESS}#loadVisibleSignTask`,
      anchor: "if (!task) throw new AppError('NOT_FOUND', '签署任务不存在')",
    },
    {
      role: 'scope',
      unit: `${RECORD_ACCESS}#recordScope`,
      anchor: 'scopeSql(scope, { person: sql`${esignTasks.employeeId}` })',
    },
  ],
};
const recordAction = (code: string): Obligation[] => [
  {
    perm: `btn:${SIGN_RECORD}#${code}@list`,
    facts: ['button:button()'],
    at: [
      { role: 'call', unit: `${RECORD_ROUTES}#batch`, anchor: "await button(deps, ctx, RECORD_OBJECT, code, 'list')" },
      {
        role: 'const',
        unit: `${RECORD_ROUTES}#batch`,
        anchor: "const code = action === 'remind' ? 'ESignRecord.Remind' : 'ESignRecord.Revoke'",
      },
      BUTTON,
      ...recordConst,
    ],
  },
  owner,
];

export const ESIGN: RequiredTable = {
  [`GET ${BASE}/records`]: [
    {
      perm: `obj:${SIGN_RECORD}:view`,
      facts: ['object:objectContext', `objectOp:${SIGN_RECORD}:view`],
      at: [
        {
          role: 'call',
          unit: `${RECORD_ROUTES}#route:GET ${BASE}/records`,
          anchor: "const ctx = await objectContext(c, deps, RECORD_OBJECT, 'view')",
        },
        CONTEXT,
        ...recordConst,
        {
          role: 'scope',
          unit: `${RECORD_ACCESS}#recordScope`,
          anchor: 'scopeSql(scope, { person: sql`${esignTasks.employeeId}` })',
        },
      ],
    },
  ],
  [`POST ${BASE}/records/remind`]: recordAction('ESignRecord.Remind'),
  [`POST ${BASE}/records/revoke`]: recordAction('ESignRecord.Revoke'),
  [`GET ${BASE}/records/files`]: [
    {
      perm: `btn:${SIGN_RECORD}#ESignRecord.Download@list`,
      at: [
        {
          role: 'call',
          unit: `${RECORD_ROUTES}#download`,
          anchor:
            'await button({ ...deps, authorize: authorizeInTransaction(deps.authorize, tx) }, ctx, ' +
            "RECORD_OBJECT, 'ESignRecord.Download', 'list',)",
        },
        BUTTON,
        ...recordConst,
      ],
    },
    owner,
    {
      perm: 'guard:esign.filesReadable',
      at: [
        { role: 'call', unit: `${RECORD_ROUTES}#download`, anchor: 'requireFiles(fields)' },
        {
          role: 'impl',
          unit: `${RECORD_ACCESS}#requireFiles`,
          anchor: "if (!canRead(fields, 'files')) throw new AppError('FIELD_FORBIDDEN', '没有电子文件查看权限')",
        },
      ],
    },
  ],
  [`GET ${BASE}/mine/:id/files`]: [
    {
      perm: 'own:esign.signer',
      at: [
        {
          role: 'call',
          unit: `${RECORD_ROUTES}#download`,
          anchor: "if (own) return downloadInputs(tx, ctx, [uuidParam(c)], 'own', undefined)",
        },
        {
          role: 'impl',
          unit: `${RECORD_ACCESS}#loadVisibleSignTask`,
          anchor: "scope === 'own' ? signer(ctx) : recordScope(scope)",
        },
        {
          role: 'scope',
          unit: `${RECORD_ACCESS}#signer`,
          anchor:
            'sql`(${esignTasks.employeeSignerUserId}=${ctx.userId}::uuid OR ' +
            '${esignTasks.initiatorUserId}=${ctx.userId}::uuid)`',
        },
      ],
    },
  ],
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
