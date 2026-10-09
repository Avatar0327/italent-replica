/**
 * 必需项表：职务体系（modules/job/routes.ts、sequence-routes.ts）。对象操作经 module-route-access.objectContext
 * （对象编码按 :kind 取 JOB_OBJECT_CODES）；按钮经 button；配置经 readContext('admin.other_settings')；引用对象经
 * assignmentReferences 逐个 objectContext + visibleJob。写入的字段权经 writeFields → requireObjectWrite。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/job/routes.ts';
const SEQUENCE = 'apps/api/src/modules/job/sequence-routes.ts';
const ACCESS = 'apps/api/src/modules/permission/module-route-access.ts';
const KINDS =
  '{TenantBase.JobGrade,TenantBase.JobLayer,TenantBase.JobLevel,TenantBase.JobLevelType,TenantBase.JobPost,' +
  'TenantBase.JobProfessionalLine,TenantBase.JobSequence,TenantBase.Position}';
const CODES = {
  role: 'const',
  unit: `${ACCESS}#JOB_OBJECT_CODES`,
  anchor: 'posts: MODULE_OBJECTS.jobPost.code',
} as const;
const OBJECT_CONTEXT = {
  role: 'impl',
  unit: `${ACCESS}#objectContext`,
  anchor:
    'await requirePermission(deps.authorize, { ...ctx, action: ' +
    '`object.${operation}`, resource: objectCode, fields: [] })',
} as const;
const BUTTON = {
  role: 'impl',
  unit: `${ACCESS}#button`,
  anchor: "action: 'object.button', resource: buttonResource(objectCode, code, level)",
} as const;
const WRITE_FIELDS = {
  role: 'impl',
  unit: `${ACCESS}#writeFields`,
  anchor: 'await requireObjectWrite(deps.authorize, ctx, {',
} as const;
const LINKED = {
  role: 'impl',
  unit: 'apps/api/src/modules/employment/context.ts#requireLinkedEmploymentRecord',
  anchor: "throw new AppError('LINKED_RECORD_OUT_OF_SCOPE'",
} as const;
const SEQUENCE_TARGETS = [
  {
    role: 'impl',
    unit: 'apps/api/src/modules/job/sequence-sync.ts#queueSequenceSync',
    anchor: "if (changed.length && !access) throw new AppError('FORBIDDEN', '未提供任职写入授权，不能同步序列')",
  },
  {
    role: 'impl',
    unit: 'apps/api/src/modules/job/sequence-targets.ts#authorizeSequenceTargets',
    anchor: "await requireEmploymentWrite(ctx, 'update', { sequenceId: target.source.sequenceId })",
  },
] as const;
const route = (method: string, path: string, anchor: string, file = ROUTES) =>
  ({ role: 'call', unit: `${file}#route:${method} /api/tenant/job${path}`, anchor }) as const;
const unit = (name: string, anchor: string, file = ROUTES) =>
  ({ role: 'call', unit: `${file}#${name}`, anchor }) as const;
const CTX = 'const ctx = await objectContext(c, deps, objectCode)';

const settings = (method: string, anchor: string): Obligation => ({
  perm: 'admin:other_settings',
  facts: ['admin:readContext(admin.*)'],
  at: [
    route(method, '/settings', anchor),
    {
      role: 'impl',
      unit: 'apps/api/src/modules/job/context.ts#readContext',
      anchor: 'await requirePermission(deps.authorize, { ...tenant, action })',
    },
  ],
});
const candidates = (code: string): Obligation[] => [
  {
    perm: `obj:${code}:view`,
    facts: ['object:objectContext'],
    at: [unit('registerCandidates', CTX), OBJECT_CONTEXT, CODES],
  },
  {
    perm: 'guard:job.assignmentReferences',
    facts: ['guard:job.assignmentReferences'],
    at: [
      unit('registerCandidates', 'const references = await assignmentReferences(c, deps, input)'),
      {
        role: 'impl',
        unit: `${ROUTES}#assignmentReferences`,
        anchor: 'const ctx = await objectContext(c, deps, code)',
      },
      {
        role: 'impl',
        unit: `${ROUTES}#assignmentReferences`,
        anchor: 'if (!scope.all) await visibleJob(tx, ctx, scope, kind, id, input.asOf)',
      },
    ],
  },
];
const linkage = (at: Evidence): Obligation => ({
  perm: 'guard:employment.linkage',
  facts: ['guard:employment.linkage'],
  note: 'DEC-178：序列同步 / 人员规则改写任职前按联动范围复核',
  at: [
    at,
    {
      role: 'impl',
      unit: 'apps/api/src/modules/job/sequence-targets.ts#authorizeSequenceTargets',
      anchor: 'await requireLinkedEmploymentRecord(',
    },
    LINKED,
  ],
});
const employmentScope = (at: Evidence): Obligation => ({
  perm: 'guard:job.employmentScope',
  facts: ['guard:job.employmentScope'],
  note: '序列变化同步任职：任职范围 + 任职 update 字段权（无授权 403）',
  at: [at, ...SEQUENCE_TARGETS],
});
const syncSequence = (kind: 'posts' | 'positions', code: string): Obligation[] => {
  const path = `/${kind}/sync-sequence`;
  const call = (anchor: string) => route('POST', path, anchor, SEQUENCE);
  return [
    {
      perm: `obj:${code}:view`,
      facts: ['object:objectContext'],
      at: [call('const ctx = await objectContext(c, deps, code, undefined, revision(c))'), OBJECT_CONTEXT, CODES],
    },
    {
      perm: `btn:${code}#syncSequence@list`,
      facts: ['button:button()'],
      at: [call("await button(deps, ctx, code, 'syncSequence', 'list')"), BUTTON, CODES],
    },
    {
      perm: `obj:${code}:update`,
      note: '逐项：对象有序列时 writeFields(code, update, { sequenceId })',
      at: [call("ctx, code, 'update', { sequenceId: record.sequenceId, }"), WRITE_FIELDS, CODES],
    },
    employmentScope(call('const taskId = await queueSequenceSync(tx, writeCtx, sources, {')),
    linkage(call('const taskId = await queueSequenceSync(tx, writeCtx, sources, {')),
  ];
};
const receipts = (path: string, anchor: string): Obligation[] => [
  {
    perm: 'own:job.sequenceReceiptRecipient',
    facts: ['own:recipientUserId = 本人'],
    at: [route('GET', path, anchor, SEQUENCE)],
  },
  {
    perm: 'obj:TenantBase.EmploymentRecord:view',
    purpose: 'disclosure:receiptRows',
    facts: ['object:object.* 动作'],
    note: '任职查看权（及 sequenceId / id 字段可见）只决定回执行是否整体裁剪',
    at: [
      route('GET', path, 'visibleSequenceReceipts(', SEQUENCE),
      {
        role: 'impl',
        unit: 'apps/api/src/modules/job/sequence-receipts.ts#visibleSequenceReceipts',
        anchor: "action: 'object.view', resource: code, fields: []",
      },
    ],
  },
];

export const JOB: RequiredTable = {
  'GET /api/tenant/job/settings': [settings('GET', "const ctx = await readContext(c, deps, 'admin.other_settings')")],
  'PUT /api/tenant/job/settings': [
    settings('PUT', "const ctx = await readContext(c, deps, 'admin.other_settings', revision(c))"),
  ],
  'GET /api/tenant/job/candidates/levels': candidates('TenantBase.JobLevel'),
  'GET /api/tenant/job/candidates/grades': candidates('TenantBase.JobGrade'),
  'POST /api/tenant/job/validate-assignment': [
    {
      perm: 'obj:TenantBase.JobPost:view',
      facts: ['object:objectContext'],
      at: [route('POST', '/validate-assignment', CTX), OBJECT_CONTEXT],
    },
    {
      perm: 'btn:TenantBase.JobPost#validate@detail',
      facts: ['button:button()'],
      at: [route('POST', '/validate-assignment', "await button(deps, ctx, objectCode, 'validate', 'detail')"), BUTTON],
    },
    {
      perm: 'guard:job.assignmentReferences',
      facts: ['guard:job.assignmentReferences'],
      at: [
        route('POST', '/validate-assignment', 'const references = await assignmentReferences(c, deps, input)'),
        {
          role: 'impl',
          unit: `${ROUTES}#assignmentReferences`,
          anchor: 'const ctx = await objectContext(c, deps, code)',
        },
      ],
    },
  ],
  'POST /api/tenant/job/import': [
    {
      perm: `obj:${KINDS}:view`,
      facts: ['object:objectContext'],
      at: [unit('importJobRows', 'await objectContext(c, deps, objectCode)'), OBJECT_CONTEXT, CODES],
    },
    {
      perm: `btn:${KINDS}#import@list`,
      facts: ['button:button()'],
      at: [unit('importJobRows', "await button(deps, ctx, objectCode, 'import', 'list')"), BUTTON, CODES],
    },
    {
      perm: `obj:${KINDS}:{mapper:job.importRowOperation}`,
      note: '逐行：有目标对象判 update，否则 create',
      at: [unit('importJobRows', "targetId ? 'update' : 'create'"), WRITE_FIELDS, CODES],
    },
    employmentScope(unit('importJobRows', 'sequenceAccess,')),
    linkage(unit('importJobRows', 'sequenceAccess,')),
  ],
  'GET /api/tenant/job/sequence-sync/messages': receipts(
    '/sequence-sync/messages',
    "AND payload->'after'->>'recipientUserId'=",
  ),
  'GET /api/tenant/job/sequence-sync/tasks/:id': receipts(
    '/sequence-sync/tasks/:id',
    "AND o.payload->'after'->>'recipientUserId'=",
  ),
  'POST /api/tenant/job/posts/sync-sequence': syncSequence('posts', 'TenantBase.JobPost'),
  'POST /api/tenant/job/positions/sync-sequence': syncSequence('positions', 'TenantBase.Position'),
  'GET /api/tenant/job/:kind': [
    {
      perm: `obj:${KINDS}:view`,
      facts: ['object:objectContext'],
      at: [route('GET', '/:kind', CTX), OBJECT_CONTEXT, CODES],
    },
  ],
  'GET /api/tenant/job/:kind/:id': [
    {
      perm: `obj:${KINDS}:view`,
      facts: ['object:objectContext'],
      at: [route('GET', '/:kind/:id', CTX), OBJECT_CONTEXT, CODES],
    },
  ],
  'POST /api/tenant/job/:kind': [
    {
      perm: `obj:${KINDS}:create`,
      facts: ['object:objectContext'],
      at: [
        route('POST', '/:kind', "const ctx = await objectContext(c, deps, objectCode, 'create', revision(c))"),
        OBJECT_CONTEXT,
        route('POST', '/:kind', "await writeFields(deps, ctx, objectCode, 'create', input)"),
        WRITE_FIELDS,
        CODES,
      ],
    },
  ],
  'PATCH /api/tenant/job/:kind/:id': [
    {
      perm: `obj:${KINDS}:update`,
      facts: ['object:objectContext', 'object:object.* 动作', 'object:requireObjectWrite（对象写操作权）'],
      at: [
        route('PATCH', '/:kind/:id', "const ctx = await objectContext(c, deps, objectCode, 'update', revision(c))"),
        OBJECT_CONTEXT,
        route('PATCH', '/:kind/:id', "await writeFields(deps, ctx, objectCode, 'update', fields)"),
        WRITE_FIELDS,
        CODES,
      ],
    },
    {
      perm: 'guard:job.orgIdInScope',
      at: [
        route(
          'PATCH',
          '/:kind/:id',
          "if ((input as JobPatch).orgId) visible(scope, (input as JobPatch).orgId as string, '职务体系对象不存在或已失效')",
        ),
      ],
    },
    {
      perm: 'guard:job.employmentPersonnel',
      note: '职位人员规则（调整直线经理）写任职：无任职写入授权 → 403',
      at: [
        route('PATCH', '/:kind/:id', 'const personnel = employmentJobPersonnel('),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/job/employment-port.ts#employmentJobPersonnel',
          anchor: "if (!access) throw new AppError('FORBIDDEN', '未提供任职写入授权，不能同步直线经理')",
        },
      ],
    },
    employmentScope(
      route(
        'PATCH',
        '/:kind/:id',
        'employmentScope ? { scope: employmentScope, authorize: deps.authorize } : undefined',
      ),
    ),
    linkage(
      route(
        'PATCH',
        '/:kind/:id',
        'employmentScope ? { scope: employmentScope, authorize: deps.authorize } : undefined',
      ),
    ),
  ],
};
