import type { ModuleDeclared } from '../../module-declared.js';

/** talent-review 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const TALENT_REVIEW_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: ['POST /api/tenant/talent-review/templates/:id/copy'],
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'POST /api/tenant/talent-review/matrices/:id/ratio-groups',
    'POST /api/tenant/talent-review/templates/:id/copy',
  ],
};
