/**
 * 必需项表：编制（modules/establishment/routes.ts）。对象操作经 module-route-access.objectContext（对象编码
 * MODULE_OBJECTS.establishment）；按钮经 button；配置经 readContext('admin.other_settings')；编制组织范围
 * （orgId 可见）、复制任务来源编制、复制任务可见经 visible / visibleCapacity / visibleCopyJob（范围外 404）。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/establishment/routes.ts';
const ACCESS = 'apps/api/src/modules/permission/module-route-access.ts';
const OBJ = 'TenantBase.OrganizationEstablishment';
const OBJECT_CONST: Evidence[] = [
  { role: 'const', unit: `${ROUTES}#OBJECT`, anchor: 'MODULE_OBJECTS.establishment.code' },
  {
    role: 'const',
    unit: 'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS>establishment',
    anchor: "object( 'OrganizationEstablishment'",
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
const call = (method: string, path: string, anchor: string): Evidence => ({
  role: 'call',
  unit: `${ROUTES}#route:${method} /api/tenant/establishment${path}`,
  anchor,
});

function op(method: string, path: string, operation: 'view' | 'create' | 'update' | 'delete'): Obligation {
  const anchor =
    operation === 'view'
      ? 'const ctx = await objectContext(c, deps, OBJECT)'
      : `const ctx = await objectContext(c, deps, OBJECT, '${operation}', revision(c))`;
  return {
    perm: `obj:${OBJ}:${operation}`,
    facts: ['object:objectContext', `objectOp:${OBJ}:${operation}`],
    at: [call(method, path, anchor), CONTEXT, ...OBJECT_CONST],
  };
}
function btn(method: string, path: string, code: string, level: 'list' | 'detail'): Obligation {
  return {
    perm: `btn:${OBJ}#${code}@${level}`,
    facts: ['button:button()'],
    at: [call(method, path, `await button(deps, ctx, OBJECT, '${code}', '${level}')`), BUTTON, ...OBJECT_CONST],
  };
}
function copyJob(method: string, path: string, anchor: string): Obligation {
  return {
    perm: 'guard:establishment.visibleCopyJob',
    at: [
      call(method, path, anchor),
      {
        role: 'impl',
        unit: `${ROUTES}#visibleCopyJob`,
        anchor: "visible(scope, capacity.orgId, '复制任务不存在', record.createdBy)",
      },
    ],
  };
}
const settings = (method: string, anchor: string): Obligation => ({
  perm: 'admin:other_settings',
  facts: ['admin:readContext(admin.*)'],
  at: [
    call(method, '/settings', anchor),
    {
      role: 'impl',
      unit: 'apps/api/src/modules/job/context.ts#readContext',
      anchor: 'await requirePermission(deps.authorize, { ...tenant, action })',
    },
  ],
});

export const ESTABLISHMENT: RequiredTable = {
  'GET /api/tenant/establishment/schemes': [op('GET', '/schemes', 'view')],
  'GET /api/tenant/establishment/schemes/:id': [op('GET', '/schemes/:id', 'view')],
  'POST /api/tenant/establishment/schemes': [op('POST', '/schemes', 'create')],
  'PATCH /api/tenant/establishment/schemes/:id': [op('PATCH', '/schemes/:id', 'update')],
  'DELETE /api/tenant/establishment/schemes/:id': [
    op('DELETE', '/schemes/:id', 'delete'),
    btn('DELETE', '/schemes/:id', 'delete', 'detail'),
  ],
  'GET /api/tenant/establishment/capacities': [op('GET', '/capacities', 'view')],
  'GET /api/tenant/establishment/capacities/:id': [op('GET', '/capacities/:id', 'view')],
  'POST /api/tenant/establishment/capacities': [op('POST', '/capacities', 'create')],
  'PATCH /api/tenant/establishment/capacities/:id': [
    op('PATCH', '/capacities/:id', 'update'),
    {
      perm: 'guard:establishment.orgIdInScope',
      at: [call('PATCH', '/capacities/:id', "if (input.orgId) visible(scope, input.orgId, '编制在该时点不存在')")],
    },
  ],
  'GET /api/tenant/establishment/settings': [
    settings('GET', "const ctx = await readContext(c, deps, 'admin.other_settings')"),
  ],
  'PUT /api/tenant/establishment/settings': [
    settings('PUT', "const ctx = await readContext(c, deps, 'admin.other_settings', revision(c))"),
  ],
  'POST /api/tenant/establishment/copy-jobs': [
    op('POST', '/copy-jobs', 'create'),
    btn('POST', '/copy-jobs', 'copy', 'list'),
    {
      perm: 'guard:establishment.copyJobSources',
      at: [
        call(
          'POST',
          '/copy-jobs',
          'for (const id of input.capacityIds) await visibleCapacity(tx, ctx, scope, id, queryDate(c, ctx))',
        ),
        {
          role: 'impl',
          unit: `${ROUTES}#visibleCapacity`,
          anchor: "visible( scope, record.orgId, '编制在该时点不存在'",
        },
      ],
    },
  ],
  'GET /api/tenant/establishment/copy-jobs/:id': [
    op('GET', '/copy-jobs/:id', 'view'),
    copyJob('GET', '/copy-jobs/:id', 'visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx))'),
  ],
  'POST /api/tenant/establishment/copy-jobs/:id/execute': [
    op('POST', '/copy-jobs/:id/execute', 'update'),
    btn('POST', '/copy-jobs/:id/execute', 'execute', 'detail'),
    copyJob('POST', '/copy-jobs/:id/execute', 'await visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx))'),
  ],
  'GET /api/tenant/establishment/copy-jobs/:id/report': [
    op('GET', '/copy-jobs/:id/report', 'view'),
    btn('GET', '/copy-jobs/:id/report', 'report', 'detail'),
    copyJob('GET', '/copy-jobs/:id/report', 'await visibleCopyJob(tx, ctx, scope, id, queryDate(c, ctx))'),
  ],
  'GET /api/tenant/establishment/notifications': [
    {
      perm: 'own:establishment.notificationRecipient',
      facts: ['own:listTodos / listNotifications / listInstances'],
      at: [
        call('GET', '/notifications', 'listNotifications(tx, ctx.tenantId, ctx.userId, page, scope)'),
        {
          role: 'impl',
          unit: 'apps/api/src/modules/establishment/copy-service.ts#listNotifications',
          anchor: 'eq(establishmentNotifications.recipientUserId, recipientUserId)',
        },
      ],
    },
    op('GET', '/notifications', 'view'),
  ],
};
