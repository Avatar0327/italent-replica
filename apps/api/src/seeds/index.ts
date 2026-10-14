/**
 * 种子登记入口（DEC-361）：每个有预置数据的模块在这里加一行 import（模块文件加载时调用 registerSeed）。
 * 开通租户与平台回补命令都 import 本文件，保证登记项一致。
 */
// 各模块的种子登记（加载即 registerSeed）；permission 先于其他模块：先补整个身份、再补授权项
import '../modules/permission/standard-seeds.js';
import '../modules/talent-review/presets.js';
import '../modules/talent-review/matrix-presets.js';
import '../modules/talent-review/form-presets.js';

export { installMissingSeeds, registeredSeeds, seedModules } from './registry.js';
export type { SeedReportItem, SeedSkip, SeedWriteContext } from './registry.js';
