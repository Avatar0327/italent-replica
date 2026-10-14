import type { ModuleDeclared } from '../../module-declared.js';

/** talent 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const TALENT_DECLARED: ModuleDeclared = {
  /** R1c：含 ≥2 个准入承载节点的备选的端点（需要 need 登记） */
  multiCarrierAdmission: [
    'DELETE /api/tenant/talent/criteria/:id/model-image',
    'GET /api/tenant/talent/forms/:object',
    'POST /api/tenant/talent/criteria/:id/model-image/attachments',
    'POST /api/tenant/talent/criteria/:id/model-image/attachments/:attachmentId/upload',
  ],
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: [
    'POST /api/tenant/talent/criteria/:id/dimension-category',
    'POST /api/tenant/talent/criteria/:id/model-image/attachments',
    'POST /api/tenant/talent/criteria/:id/model-image/attachments/:attachmentId/upload',
  ],
  /** 声明里的 map 型动态选择器位置“端点 × 位置”（AC-PRM-FW-02 选择器绑定） */
  selectorSites: [
    ['GET /api/tenant/talent/candidates/owner-orgs', 'of[0].object'],
    ['GET /api/tenant/talent/forms/:object', 'of[0].button'],
    ['GET /api/tenant/talent/forms/:object', 'of[0].object'],
    ['GET /api/tenant/talent/forms/:object', 'of[0].operation'],
    ['GET /api/tenant/talent/forms/:object', 'of[1].object'],
  ],
  /** 输入来源表（branch-inputs.ts）里有登记的端点 */
  branchInputEndpoints: ['GET /api/tenant/talent/candidates/owner-orgs', 'GET /api/tenant/talent/forms/:object'],
};
