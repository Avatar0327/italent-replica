import { tenantLocalDate } from '@italent/domain';
import { listJobObjects } from '../job/read-model.js';
import type { CalcProducer } from './calc-jobs.js';
import { enqueueCalcRun } from './calc-worker.js';
import { calcScheduleSlot } from './calc-time.js';
export const riskProducer: CalcProducer = {
  kind: 'position_risk',
  async runTenant(tx, tenant, now) {
    const input = {
      tenantId: tenant.id,
      kind: 'position_risk' as const,
      trigger: 'schedule' as const,
      requestedBy: null,
      timezone: tenant.timezone,
      now,
      businessDate: tenantLocalDate(now, tenant.timezone),
      commandId: `risk:${now.toISOString()}`,
      objects: [],
    };
    const { businessDate } = calcScheduleSlot(input);
    const objects = [];
    for (let offset = 0; ; offset += 200) {
      const page = await listJobObjects(tx, tenant.id, 'positions', { asOf: businessDate, offset, limit: 200 });
      objects.push(
        ...page.filter((p) => p.enabled && p.isKey).map((p) => ({ objectType: 'position' as const, objectId: p.id })),
      );
      if (page.length < 200) break;
    }
    await enqueueCalcRun(tx, { ...input, businessDate, objects }, now);
  },
};
