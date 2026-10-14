import type { ModuleDeclared } from '../../module-declared.js';

/** permission 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const PERMISSION_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'DELETE /api/tenant/permission/dynamic-org-grants/:grantId',
    'DELETE /api/tenant/permission/mous/:id',
    'GET /api/tenant/permission/admins/:id',
    'GET /api/tenant/permission/dynamic-org-grants/:grantId',
    'GET /api/tenant/permission/mous/:id',
    'GET /api/tenant/permission/profiles/:id',
    'GET /api/tenant/permission/profiles/:id/data-scopes/:appCode',
    'GET /api/tenant/permission/users/:userId',
    'POST /api/tenant/permission/grants/:id/revoke',
    'POST /api/tenant/permission/users/:userId/remove',
    'POST /api/tenant/permission/users/:userId/status',
  ],
};
