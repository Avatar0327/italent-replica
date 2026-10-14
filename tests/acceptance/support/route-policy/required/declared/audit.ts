import type { ModuleDeclared } from '../../module-declared.js';

/** audit 模块的 F-039 共享集合声明（DEC-475④）：新增 / 删除本模块路由时只改这里。 */
export const AUDIT_DECLARED: ModuleDeclared = {
  /** 授权轨迹里仍询问 Activity 查看 / viewAll 键的“端点 × 请求键”（AC-PRM-F075b） */
  activityKeyRequests: [
    ['GET /api/tenant/audit/command-failures', 'btn:Survey360.Activity#viewAll@list'],
    ['GET /api/tenant/audit/command-failures', 'obj:Survey360.Activity:view'],
  ],
};
