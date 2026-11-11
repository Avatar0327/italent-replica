/** AC-F512-01：apps/api 各模块作为首个入口加载均不抛错（分片 1/4，见 support/module-load-guard.ts）。 */
import { registerModuleLoadGuard } from './support/module-load-guard.js';

registerModuleLoadGuard(0, 4);
