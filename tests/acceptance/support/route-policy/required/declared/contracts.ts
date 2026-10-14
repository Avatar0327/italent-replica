import type { ModuleDeclared } from '../../module-declared.js';

/** contracts 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const CONTRACTS_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'PUT /api/tenant/contracts/master-data/companies/:id',
    'PUT /api/tenant/contracts/master-data/types/:id',
    'PUT /api/tenant/contracts/rules/:id',
  ],
  /** 声明里的 map 型动态选择器位置“端点 × 位置”（AC-PRM-FW-02 选择器绑定） */
  selectorSites: [
    ['POST /api/tenant/contracts/batch', 'operation'],
    ['POST /api/tenant/contracts/batch', 'rows.operation'],
    ['POST /api/tenant/contracts/commands', 'operation'],
    ['POST /api/tenant/contracts/imports', 'rows.operation'],
    ['POST /api/tenant/contracts/imports/errors', 'rows.operation'],
    ['POST /api/tenant/contracts/imports/preview', 'rows.operation'],
    ['POST /api/tenant/contracts/todos/batch', 'relation'],
    ['POST /api/tenant/contracts/todos/batch', 'rows.relation'],
  ],
  /** 输入来源表（branch-inputs.ts）里有登记的端点 */
  branchInputEndpoints: [
    'POST /api/tenant/contracts/batch',
    'POST /api/tenant/contracts/commands',
    'POST /api/tenant/contracts/imports',
    'POST /api/tenant/contracts/imports/errors',
    'POST /api/tenant/contracts/imports/preview',
    'POST /api/tenant/contracts/todos/batch',
  ],
};
