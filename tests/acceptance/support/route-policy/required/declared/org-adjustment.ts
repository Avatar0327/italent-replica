import type { ModuleDeclared } from '../../module-declared.js';

/**
 * org-adjustment 模块（R2-T08 BE-10b1 申请头、BE-10b2 组织明细、BE-10e 导出、BE-11c-b 调动明细）的 F-039 共享集合声明
 * （DEC-475④）：新增 / 删除本模块路由时只改这里。
 */
export const ORG_ADJUSTMENT_DECLARED: ModuleDeclared = {
  /**
   * 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点。
   * BE-10e 路由 28（preview/export）：占位请求不带必填的 after，在 after 校验处 400；非法标识在 uuid 校验处 400。
   * BE-11c-b 路由 16 / 17（transfer-items POST / PATCH）：占位请求缺必填载荷，在载荷校验处 400；非法标识在 uuid 校验处 400。
   */
  sameStatusInvalidId: [
    'PATCH /api/tenant/org-adjustment/adjustments/:id',
    'POST /api/tenant/org-adjustment/adjustments/:id/org-items',
    'PATCH /api/tenant/org-adjustment/adjustments/:id/org-items/:itemId',
    'POST /api/tenant/org-adjustment/adjustments/:id/transfer-items',
    'PATCH /api/tenant/org-adjustment/adjustments/:id/transfer-items/:itemId',
    'GET /api/tenant/org-adjustment/adjustments/:id/preview/export',
  ],
};
