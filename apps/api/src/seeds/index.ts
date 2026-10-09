/**
 * 种子登记入口（DEC-361）：每个有预置数据的模块在这里加一行 import（模块文件加载时调用 registerSeed）。
 * 开通租户与平台回补命令都 import 本文件，保证登记项一致。
 */
export { installMissingSeeds, registeredSeeds, seedModules } from './registry.js';
export type { SeedReportItem, SeedWriteContext } from './registry.js';
