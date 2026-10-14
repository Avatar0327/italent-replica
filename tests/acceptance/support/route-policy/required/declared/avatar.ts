import type { ModuleDeclared } from '../../module-declared.js';

/** avatar 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const AVATAR_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: ['POST /api/tenant/account/avatar/attachments/:attachmentId/upload'],
};
