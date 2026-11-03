import type { RequiredTable, Evidence } from './types.js';
const ROUTES = 'apps/api/src/modules/employee-self-service/application-routes.ts';
const ACCESS = 'apps/api/src/modules/employee-self-service/application-access.ts';
const SHARED = 'apps/api/src/modules/employee-self-service/access.ts';
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
    const permission: Evidence = {
      role: 'impl',
      unit: `${ACCESS}#requireApplicationAccess`,
      anchor: "resource: buttonResource(EMPLOYMENT_OBJECT, SELF_APPLICATION_BUTTONS[kind], 'detail')",
    };
    return [
      `${method} /api/tenant/self-service${path}`,
      [
        { perm: 'self', facts: ['self:selfAccess'], at },
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
