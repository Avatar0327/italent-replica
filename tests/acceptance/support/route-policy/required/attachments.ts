/**
 * 必需项表：通用附件（modules/attachments，F-479 S1）。五个入口都经 selfAccess 绑定员工，再在事务内复核 Exit.Self 按钮；
 * 写入口另经 requireEmploymentWrite 复核 attachmentRefs 字段可编辑（requireAttachmentWrite），读入口复核字段可查看
 * （requireAttachmentRead）。文件归属（本人 + 未绑定 + 状态）在 service.ownFile，是数据定位而非授权项。
 */
import type { Evidence, Obligation, RequiredTable } from './types.js';

const ROUTES = 'apps/api/src/modules/attachments/routes.ts';
const ACCESS = 'apps/api/src/modules/attachments/access.ts';
const SHARED = 'apps/api/src/modules/employee-self-service/access.ts';
const APPLICATION = 'apps/api/src/modules/employee-self-service/application-access.ts';

const bound: Evidence = { role: 'impl', unit: `${SHARED}#selfAccess`, anchor: 'boundEmployee(tx, tenant)' };
const button: Evidence = {
  role: 'impl',
  unit: `${APPLICATION}#requireApplicationAccess`,
  anchor: "resource: buttonResource(EMPLOYMENT_OBJECT, SELF_APPLICATION_BUTTONS[kind], 'detail')",
};
const writeEntry: Evidence = {
  role: 'impl',
  unit: `${ACCESS}#requireAttachmentWrite`,
  anchor: "requireApplicationAccess(tx, self, 'exit', 'create', { [ATTACHMENT_FIELD]: [] })",
};

function route(method: string, path: string, handlerAnchor: string, writing: boolean): Obligation[] {
  const call: Evidence = { role: 'call', unit: `${ROUTES}#route:${method} ${path}`, anchor: handlerAnchor };
  const at = [call, bound];
  const entry: Evidence[] = writing
    ? [
        {
          role: 'impl',
          unit: `${ROUTES}#write`,
          anchor: 'guard: { before: (tx) => requireAttachmentWrite(tx, self) }',
        },
        writeEntry,
      ]
    : [];
  return [
    { perm: 'self', facts: ['self:selfAccess'], at },
    {
      perm: 'btn:self#Exit.Self@detail',
      facts: ['button:buttonResource', 'button:object.button'],
      at: writing ? [call, ...entry, button] : [call, button],
    },
  ];
}

const BASE = '/api/tenant/attachments';
export const ATTACHMENTS: RequiredTable = {
  [`POST ${BASE}`]: route('POST', BASE, 'return write(c, deps, 0, input, 201', true),
  [`POST ${BASE}/:id/upload`]: route(
    'POST',
    `${BASE}/:id/upload`,
    'return write(c, deps, expected, { id, ...input }',
    true,
  ),
  [`DELETE ${BASE}/:id`]: route('DELETE', `${BASE}/:id`, 'return write(c, deps, expected, { id }, 200', true),
  [`GET ${BASE}/:id`]: route('GET', `${BASE}/:id`, 'await requireAttachmentRead(tx, self)', false),
  [`GET ${BASE}/:id/content`]: route('GET', `${BASE}/:id/content`, 'await requireAttachmentRead(tx, self)', false),
};
