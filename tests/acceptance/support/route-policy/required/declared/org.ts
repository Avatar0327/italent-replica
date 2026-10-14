import type { ModuleDeclared } from '../../module-declared.js';

/** org 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const ORG_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'PATCH /api/tenant/org/organizations/:id',
    'PATCH /api/tenant/org/organizations/:id/correction',
    'POST /api/tenant/org/organizations/:id/employment-preview',
  ],
  /** 已知缺口台账里本模块端点的逐对登记 */
  knownGapPairs: [['GET /api/tenant/org/person-candidates', 'obj:TenantBase.Organization:create']],
};
