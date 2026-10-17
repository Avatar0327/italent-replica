/**
 * 兼职模块的装配点（docs/08_设计/R2-T05_兼职设计.md §4.9）。生产路径是 server.ts → createApp → TENANT_MODULES →
 * registerEmploymentRoutes（apps/api/src/index.ts 只是包导出入口，不在启动路径上），所以只由 employment/routes.ts 在
 * 注册兼职子路由的同一处调用本函数；先例：继任 installSuccessionPorts()、评审组 registerReviewGroupExitHook()。
 * 重复调用安全：钩子是模块级单例常量（同名同实例幂等），删除探针同名替换。PT-6 起再登记调动端口、调动删除探针、继任端口。
 */
import { registerDeletionLinkageProbe } from '../deletion-guards.js';
import { registerEmployeeStatusHooks } from '../status-hooks.js';
import { partTimeCycleProbe } from './deletion-probe.js';
import { PART_TIME_EXIT_HOOKS } from './exit-hook.js';

export function installPartTime(): void {
  registerEmployeeStatusHooks('part-time', PART_TIME_EXIT_HOOKS);
  registerDeletionLinkageProbe('part-time', partTimeCycleProbe);
}
