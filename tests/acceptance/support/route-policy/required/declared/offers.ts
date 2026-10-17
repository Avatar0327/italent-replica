import type { ModuleDeclared } from '../../module-declared.js';

/** offers 模块（R2 BE-14a Offer 管理）的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const OFFERS_DECLARED: ModuleDeclared = {
  // 转移表单的 target 必填：占位请求在请求体校验处 400，非法标识在 uuidParam 处 400（BE-14a2）
  sameStatusInvalidId: ['POST /api/tenant/offers/:id/transfer', 'POST /api/tenant/offers/:id/toolbar-transfer'],
  multiCarrierAdmission: [
    'POST /api/tenant/offers/dictionaries/:kind',
    'PUT /api/tenant/offers/dictionaries/:kind/:id',
  ],
};
