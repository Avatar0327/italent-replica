/** AC-F512-02：apps/api 各模块作为首个入口加载均不抛错（分片 2/4，见 support/module-load-guard.ts）。 */
import { registerModuleLoadGuard } from './support/module-load-guard.js';

registerModuleLoadGuard(1, 4);
