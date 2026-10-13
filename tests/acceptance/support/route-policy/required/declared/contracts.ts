import type { ModuleDeclared } from '../../module-declared.js';

/** contracts 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const CONTRACTS_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'PUT /api/tenant/contracts/master-data/companies/:id',
    'PUT /api/tenant/contracts/master-data/types/:id',
    'PUT /api/tenant/contracts/rules/:id',
  ],
};
