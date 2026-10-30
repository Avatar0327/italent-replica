import type { ModuleDeclared } from '../../module-declared.js';

/** org-adjustment 模块（R2-T08 BE-10b1 组织调整申请头）的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const ORG_ADJUSTMENT_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: ['PATCH /api/tenant/org-adjustment/adjustments/:id'],
};
