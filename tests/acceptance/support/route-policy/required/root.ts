/**
 * 必需项表：根路由与平台运营（apps/api/src/app.ts、modules/platform/routes.ts）。
 * /healthz 公开；平台接口的运营身份由平台中间件统一校验（边界探测已覆盖），处理函数内没有对象 / 按钮 / 范围判定，
 * 表项为空数组（审定：逐条读过 platform/routes.ts 的 9 个处理函数，只取 operatorOf 作台账操作人）。
 */
import type { RequiredTable } from './types.js';

export const ROOT: RequiredTable = {
  'GET /healthz': [],
  'POST /api/platform/users': [],
  'POST /api/platform/tenants': [],
  'GET /api/platform/command-failures': [],
  'GET /api/platform/tenants/:tenantId': [],
  'POST /api/platform/tenants/:tenantId/status': [],
  'POST /api/platform/tenants/:tenantId/standard-profiles/backfill': [],
  'POST /api/platform/tenants/:tenantId/seeds/backfill': [],
  // F-082（F082-5）：存量计算公式改绑；路由与声明只在总开关打开时存在（默认已打开）。同样只取 operatorOf 作台账操作人
  'POST /api/platform/tenants/:tenantId/talent-review/calc-formulas/rebind': [],
  'GET /api/platform/tenants/:tenantId/licenses': [],
  'PUT /api/platform/tenants/:tenantId/licenses/:licenseType': [],
};
