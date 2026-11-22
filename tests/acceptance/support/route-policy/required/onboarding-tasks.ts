import type { Evidence, Need, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/onboarding/collection-task-routes.ts';
const ACCESS = 'apps/api/src/modules/onboarding/collection-access.ts';
const VIEW = 'apps/api/src/modules/onboarding/collection-task-view.ts';
const RECORD = 'TenantBase.EmploymentRecord';
const COLLECTION = 'TenantBase.OnboardingCollection';
const TARGET = 'onboarding.requireCollectionTarget';
const BASE = '/api/tenant/onboarding';
const ENTRY = '/entries/:businessId/collection';

const evidence = (role: Evidence['role'], file: string, name: string, anchor: string): Evidence => ({
  role,
  unit: `${file}#${name}`,
  anchor,
});
const target = (role: Evidence['role'], anchor: string) => evidence(role, ACCESS, 'requireCollectionTarget', anchor);
const write = (anchor: string) => evidence('impl', ACCESS, 'requireCollectionWrite', anchor);
const scope: Need = { scope: 'guard', guard: TARGET };
const scoped = [
  target('scope', 'loadEmploymentBusiness(tx, ctx.tenantId, id, today, scope, access)'),
  target('scope', 'loadEmploymentBusiness(tx, ctx.tenantId, id, today, collectionScope, access)'),
];
const objectFacts = ['object:object.* 动作'];
const writeFacts = ['object:requireObjectWrite（对象写操作权）'];
const buttonFacts = ['button:object.button', 'button:buttonResource'];

function objectReads(at: readonly Evidence[]): Obligation[] {
  return [
    {
      perm: `obj:${RECORD}:view`,
      need: scope,
      facts: [...objectFacts, `objectOp:${RECORD}:view`],
      at: [...at, target('impl', "action: 'object.view', resource: EMPLOYMENT_OBJECT"), ...scoped],
    },
    {
      perm: `obj:${COLLECTION}:view`,
      need: scope,
      facts: [...objectFacts, `objectOp:${COLLECTION}:view`],
      at: [...at, target('impl', "action: 'object.view', resource: COLLECTION"), ...scoped],
    },
    { perm: `guard:${TARGET}`, at: [...at, ...scoped] },
  ];
}

function writeAccess(at: readonly Evidence[], operation: 'create' | 'update', code: string, level: 'detail' | 'list') {
  return [
    {
      perm: `obj:${RECORD}:update`,
      need: scope,
      facts: writeFacts,
      at: [...at, write("objectCode: EMPLOYMENT_OBJECT, operation: 'update'"), ...scoped],
    },
    {
      perm: `obj:${COLLECTION}:${operation}`,
      need: scope,
      facts: writeFacts,
      at: [...at, write('objectCode: COLLECTION, operation:'), ...scoped],
    },
    {
      perm: `btn:${RECORD}#BE16.${code}@${level}`,
      facts: buttonFacts,
      at: [
        ...at,
        write("action: 'object.button', resource: buttonResource(EMPLOYMENT_OBJECT, button.code, button.level)"),
        evidence('const', ACCESS, 'COLLECTION_BUTTONS', `'BE16.${code}'`),
      ],
    },
  ];
}

function taskWrite(path: string, code: string, operation: 'create' | 'update', batch = false): Obligation[] {
  const at = [
    evidence('call', ROUTES, `route:POST ${path}`, batch ? 'startBatch(c, deps)' : 'writeCollection(c, deps,'),
    evidence('call', ROUTES, 'taskCommand', "await requireCollectionWrite(tx, deps, ctx, batch ? 'batch' : action)"),
    evidence('call', ROUTES, 'taskCommand', "await requireCollectionTarget(tx, deps, ctx, id, 'write')"),
  ];
  return [...objectReads(at), ...writeAccess(at, operation, code, batch ? 'list' : 'detail')];
}

const readAt = [
  evidence('call', ROUTES, `route:GET ${ENTRY}`, 'readCollection(c, deps)'),
  evidence('call', ROUTES, 'readCollection', "await requireCollectionTarget(tx, deps, ctx, id, 'read')"),
];
const actionAt = [
  readAt[0]!,
  evidence('call', VIEW, 'collectionActions', 'await requireCollectionWrite(tx, deps, ctx, action)'),
];
const availableActions = [
  ...writeAccess(actionAt, 'create', 'CollectionStart', 'detail'),
  ...writeAccess(actionAt, 'update', 'CollectionComment', 'detail').slice(1),
  {
    perm: `guard:${TARGET}`,
    at: [
      ...actionAt,
      evidence(
        'scope',
        VIEW,
        'collectionActions',
        "await requireCollectionTarget(tx, deps, ctx, stage.currentBusinessId, 'write', false)",
      ),
      ...scoped,
    ],
    facts: [],
  },
].map((ob) => ({
  ...ob,
  facts: ob.perm.startsWith('obj:') ? [] : ob.facts,
  need: scope,
  purpose: 'disclosure:availableActions' as const,
}));

function form(key: 'profile' | 'education' | 'certificate', code: string): Obligation[] {
  const need: Need = { scope: 'guard', guard: 'onboarding.visibleForm' };
  const at = [
    readAt[0]!,
    evidence('impl', VIEW, 'visibleForm', "action: 'object.view', resource: object"),
    evidence(
      'scope',
      VIEW,
      'visibleForm',
      'await requirePerson(tx, { ...ctx, scope, objectCode: object }, stage.employeeId)',
    ),
  ];
  return [`obj:TenantBase.${code}:view`, 'guard:onboarding.visibleForm'].map((perm) => ({
    perm,
    purpose: `disclosure:${key}`,
    need,
    at,
  }));
}

export const ONBOARDING_TASKS: RequiredTable = {
  [`GET ${BASE}${ENTRY}`]: [
    ...objectReads(readAt),
    ...availableActions,
    ...form('profile', 'EmployeeInformation'),
    ...form('education', 'Education'),
    ...form('certificate', 'Certificate'),
  ],
  [`POST ${BASE}${ENTRY}/start`]: taskWrite(`${ENTRY}/start`, 'CollectionStart', 'create'),
  [`POST ${BASE}${ENTRY}/remind`]: taskWrite(`${ENTRY}/remind`, 'CollectionRemind', 'update'),
  [`POST ${BASE}${ENTRY}/comments`]: taskWrite(`${ENTRY}/comments`, 'CollectionComment', 'update'),
  [`POST ${BASE}/collection/start-batch`]: taskWrite('/collection/start-batch', 'CollectionStartBatch', 'create', true),
};
