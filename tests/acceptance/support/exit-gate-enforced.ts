/**
 * 在测试文件顶部 `import './support/exit-gate-enforced.js'`：本文件的 tenantApi 对 kind=leave 的通用创建走真实离职门禁
 * （缺省改走可信造数端口，见 tenant-api.ts pinExitGate）。
 */
import { pinExitGate } from './tenant-api.js';

pinExitGate('enforce');
