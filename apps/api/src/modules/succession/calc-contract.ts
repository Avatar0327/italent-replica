/** B3a / DEC-427：可信的模块内端口，不是 HTTP 授权入口。A3/C1/B4/B5 只追加 kind 实例。 */
import { defineCalcKinds } from './calc-contract-core.js';
import { EXIT_SWEEP_HANDLER } from './exit-sweep.js';
import { createHealthHandler } from './health-worker.js';
import { orgStatsHandler } from './org-stats.js';
import { riskHandler } from './risk-worker.js';

export * from './calc-contract-core.js';

/** A3 的 exit_sweep/employee、C1 的 org_stats/org、B4/B5 的 position/org 在此追加模块级实例。 */
export const SUCCESSION_CALC_KINDS = defineCalcKinds([
  EXIT_SWEEP_HANDLER,
  orgStatsHandler,
  riskHandler,
  createHealthHandler('org_health'),
  createHealthHandler('org_health_reset'),
]);
