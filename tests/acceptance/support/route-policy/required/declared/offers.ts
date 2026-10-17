import type { ModuleDeclared } from '../../module-declared.js';

/** offers 模块（R2 BE-14a Offer 管理）的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const OFFERS_DECLARED: ModuleDeclared = {
  multiCarrierAdmission: [
    'POST /api/tenant/offers/dictionaries/:kind',
    'PUT /api/tenant/offers/dictionaries/:kind/:id',
  ],
};
