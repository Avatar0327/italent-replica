import type { RequiredTable, Evidence, Obligation } from './types.js';
const ROUTES = 'apps/api/src/modules/employee-self-service/application-routes.ts';
const ACCESS = 'apps/api/src/modules/employee-self-service/application-access.ts';
const SHARED = 'apps/api/src/modules/employee-self-service/access.ts';
const permission: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#requireApplicationAccess`,
  anchor: "resource: buttonResource(EMPLOYMENT_OBJECT, SELF_APPLICATION_BUTTONS[kind], 'detail')",
};
function capabilities(at: Evidence[]): Obligation[] {
  return (['create', 'update'] as const).map((operation) => ({
    perm: `obj:TenantBase.EmploymentRecord:${operation}`,
    purpose: `disclosure:${operation === 'create' ? 'fieldModes' : 'updateCapability'}`,
    need: { scope: 'none' },
    facts: ['object:object.* 动作'],
    at: [
      ...at,
      {
        role: 'impl',
        unit: `${ACCESS}#applicationForm`,
        anchor: operation === 'create' ? "allowed('object.create', [code])" : "allowed('object.update', [])",
      },
    ],
  }));
}
function writes(at: Evidence[], create: boolean): Obligation[] {
  return [
    {
      perm: 'guard:employment.linkage',
      facts: ['guard:employment.linkage'],
      at: [
        ...at,
        {
          role: 'impl',
          unit: 'apps/api/src/modules/employment/context.ts#requireLinkedEmploymentRecord',
          anchor: "throw new AppError('LINKED_RECORD_OUT_OF_SCOPE'",
        },
      ],
    },
    {
      perm: `obj:TenantBase.EmploymentRecord:${create ? 'create' : 'update'}`,
      purpose: 'guard:selfService.application',
      inner: { role: 'required' },
      facts: ['object:object.* 动作'],
      at: [
        ...at,
        {
          role: 'impl',
          unit: `${ACCESS}#requireApplicationAccess`,
          anchor: 'await requireEmploymentWrite({ ...self.ctx, authorize }, operation, payload',
        },
      ],
    },
  ];
}
const detailAt: Evidence[] = [
  {
    role: 'call',
    unit: 'apps/api/src/modules/employee-self-service/routes.ts#route:GET /applications/:id',
    anchor: 'readSelfApplication(c, deps, item)',
  },
  {
    role: 'impl',
    unit: 'apps/api/src/modules/employee-self-service/routes.ts#readSelfApplication',
    anchor: 'await requireApplicationAccess(tx, access, kind)',
  },
  permission,
];
export const OWN_APPLICATION_ACCESS: Obligation[] = [
  { perm: 'guard:selfService.application', facts: ['guard:selfService.application'], at: detailAt },
  ...(['exit', 'partTime'] as const).map((kind): Obligation => ({
    perm: `btn:self#${kind === 'exit' ? 'Exit.Self' : 'PartTime.Self'}@detail`,
    purpose: 'guard:selfService.application',
    inner: { role: 'when', condition: `applicationKind=${kind}` },
    facts: ['button:buttonResource', 'button:object.button'],
    at: detailAt,
  })),
];
const entries = [
  ['GET', '/exit-requests/form', 'Exit.Self', 'form'],
  ['GET', '/exit-requests/:id', 'Exit.Self', 'read'],
  ['POST', '/exit-requests', 'Exit.Self', 'write'],
  ['PATCH', '/exit-requests/:id', 'Exit.Self', 'write'],
  ['POST', '/exit-requests/:id/submit', 'Exit.Self', 'write'],
  ['GET', '/part-time-requests/form', 'PartTime.Self', 'form'],
  ['GET', '/part-time-requests/references/:code', 'PartTime.Self', 'references'],
  ['GET', '/part-time-requests/:id', 'PartTime.Self', 'read'],
  ['POST', '/part-time-requests', 'PartTime.Self', 'write'],
  ['PATCH', '/part-time-requests/:id', 'PartTime.Self', 'write'],
  ['POST', '/part-time-requests/:id/submit', 'PartTime.Self', 'write'],
] as const;
/** 显式列出所有本片端点；不从产品声明或探测器生成。 */
export const SELF_APPLICATIONS: RequiredTable = Object.fromEntries(
  entries.map(([method, path, code, handler]) => {
    const at: Evidence[] = [
      { role: 'call', unit: `${ROUTES}#route:${method} ${path}`, anchor: `${handler}(c, deps` },
      { role: 'impl', unit: `${SHARED}#selfAccess`, anchor: 'boundEmployee(tx, tenant)' },
    ];
    return [
      `${method} /api/tenant/self-service${path}`,
      [
        { perm: 'self', facts: ['self:selfAccess'], at },
        ...(handler === 'form' ? capabilities(at) : []),
        ...(handler === 'write' ? writes(at, method === 'POST' && !path.includes(':id')) : []),
        {
          perm: `btn:self#${code}@detail`,
          facts: ['button:buttonResource', 'button:object.button'],
          at: [...at, permission],
        },
        {
          perm: 'guard:selfService.application',
          facts: ['guard:selfService.application'],
          at: [...at, permission],
        },
      ],
    ];
  }),
);
