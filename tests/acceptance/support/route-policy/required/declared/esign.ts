import type { ModuleDeclared } from '../../module-declared.js';

/** esign 模块（F-481 / F-505 电子签署）的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const ESIGN_DECLARED: ModuleDeclared = {
  /** 状态码相同、错误体不同，由实际行为证明非法标识声明适用的端点 */
  sameStatusInvalidId: ['PATCH /api/tenant/esign/templates/:id', 'POST /api/tenant/esign/mine/:id/sign'],
};

/** F-505 S2 静态路径清单；配置对象无范围、无按钮、无标识参数。 */
export const ESIGN_SOURCE_SETTINGS = ['offer', 'entry'] as const;
