/**
 * 必需项表：调动电子签署配置（modules/esign/routes.ts，F-481 S1；设计 §10）。对象操作经 module-route-access.objectContext
 * （配置对象 TenantBase.ESignSettings，只有数据操作开关，无按钮与范围）；写入字段权经 writeFields；写命令的事务内复核
 * 由 write() 的 guard.before 再按当前权限复核一次。模板下拉与发起调动同一授权：任职对象新增 + Transfer.Hr 按钮（button）。
 */
import type { Evidence, Need, Obligation, RequiredTable } from './types.js';

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
const TASK_ROUTES = 'apps/api/src/modules/esign/task-routes.ts';
const REISSUE = 'apps/api/src/modules/esign/reissue.ts';
const MINE = 'apps/api/src/modules/esign/mine.ts';
const taskCall = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${TASK_ROUTES}#route:${method} ${BASE}${path}`,
  anchor,
});
function reissue(method: string, path: string): Obligation[] {
  // POST 还在命令事务内复核当前权限；这些直接授权原语归属同一对象/按钮义务。
  const transaction = (anchor: string): Evidence[] =>
    method === 'POST'
      ? [
          taskCall(method, path, 'await authorizeReissue(tx, deps, ctx)'),
          { role: 'impl', unit: `${REISSUE}#authorizeReissue`, anchor },
        ]
      : [];
  const scope: Evidence[] =
    method === 'POST'
      ? [
          {
            role: 'scope',
            unit: `${REISSUE}#visibleTransfer`,
            anchor:
              'loadEmploymentBusiness(tx, ctx.tenantId, id, ' +
              "tenantLocalDate(ctx.now, ctx.timezone), ctx.scope, 'write',)",
          },
        ]
      : [];
  const need: Need = method === 'POST' ? { scope: 'point', locator: 'esign.transferWrite' } : { scope: 'none' };
  return [
    {
      need,
      perm: `obj:${RECORD}:update`,
      facts: [
        'object:objectContext',
        `objectOp:${RECORD}:update`,
        ...(method === 'POST' ? ['object:object.* 动作'] : []),
      ],
      at: [
        taskCall(method, path, "const ctx = await objectContext(c, deps, EMPLOYMENT_OBJECT, 'update')"),
        CONTEXT,
        ...transaction(
          "await requirePermission(authorize, { ...ctx, action: 'object.update', " +
            'resource: EMPLOYMENT_OBJECT, fields: [] })',
        ),
        ...RECORD_CONST,
        ...scope,
      ],
    },
    {
      need,
      perm: `btn:${RECORD}#MulLaunchESignTranfer@list`,
      facts: ['button:button()', ...(method === 'POST' ? ['button:buttonResource', 'button:object.button'] : [])],
      at: [
        taskCall(method, path, "await button(deps, ctx, EMPLOYMENT_OBJECT, REISSUE_BUTTON, 'list')"),
        BUTTON,
        ...transaction(
          "await requirePermission(authorize, { ...ctx, action: 'object.button', " +
            "resource: buttonResource(EMPLOYMENT_OBJECT, REISSUE_BUTTON, 'list'), })",
        ),
        ...RECORD_CONST,
        { role: 'const', unit: `${REISSUE}#REISSUE_BUTTON`, anchor: "'MulLaunchESignTranfer'" },
        ...scope,
      ],
    },
  ];
}
function mine(method: string, path: string, anchor: string, impl: string): Obligation[] {
  return [
    {
      perm: 'own:esign.signer',
      note: '本人谓词由 signerPredicate 的 SQL 与 HTTP 越权验收证明，不虚构探测器原语。',
      at: [
        taskCall(method, path, anchor),
        { role: 'impl', unit: `${MINE}#${impl}`, anchor: 'signerPredicate(ctx.userId)' },
        {
          role: 'impl',
          unit: `${MINE}#signerPredicate`,
          anchor: 'or(eq(esignTasks.employeeSignerUserId, userId), eq(esignTasks.initiatorUserId, userId))',
        },
      ],
    },
  ];
}

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
  [`GET ${BASE}/template-options/reissue`]: reissue('GET', '/template-options/reissue'),
  [`POST ${BASE}/transfer-tasks`]: reissue('POST', '/transfer-tasks'),
  [`GET ${BASE}/mine`]: mine('GET', '/mine', 'listMine(tx, ctx, parsed.data)', 'listMine'),
  [`GET ${BASE}/mine/:id`]: mine('GET', '/mine/:id', 'mineDetail(tx, ctx, id)', 'ownSignTask'),
  [`POST ${BASE}/mine/:id/sign`]: mine('POST', '/mine/:id/sign', 'await ownSignTask(tx, ctx, id)', 'ownSignTask'),
};
