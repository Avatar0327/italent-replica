/** DEC-429：按租户冻结本期全部有效组织，主体范围在每页 / 每对象重验，范围不足保留失败结果。 */
import { tenantLocalDate } from '@italent/domain';
import { loadOrgSnapshot } from '../org/read-model.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { enqueueCalcRun } from './calc-worker.js';
import type { CalcProducer } from './calc-jobs.js';
export const orgStatsProducer: CalcProducer = {
  kind: 'org_stats',
  async runTenant(tx, tenant, now) {
    const businessDate = tenantLocalDate(now, tenant.timezone);
    const orgs = await loadOrgSnapshot(tx, tenant.id, businessDate, undefined, { includeDisabled: false });
    await enqueueCalcRun(
      tx,
      {
        tenantId: tenant.id,
        kind: 'org_stats',
        trigger: 'schedule',
        requestedBy: null,
        businessDate,
        timezone: tenant.timezone,
        now,
        intervalHours: Number((await readEffectiveSetting(tx, tenant.id, 'succession.org_stats_interval_hours')).value),
        commandId: `org_stats:${now.toISOString()}`,
        objects: orgs.map((o) => ({ objectType: 'org', objectId: o.id })),
      },
      now,
    );
  },
};
