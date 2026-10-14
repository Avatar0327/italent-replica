import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { SUCCESSION_PRODUCERS } from '../../apps/api/src/modules/succession/calc-jobs.js';
import { SUCCESSION_CALC_KINDS } from '../../apps/api/src/modules/succession/calc-contract.js';
import { runCalcPage, enqueueCalcRun } from '../../apps/api/src/modules/succession/calc-worker.js';
import { readOnDutyCount, createOrgStatsHandler } from '../../apps/api/src/modules/succession/org-stats.js';
import { calcScheduleSlot } from '../../apps/api/src/modules/succession/calc-time.js';
import { tenantLocalDate } from '@italent/domain';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { successionWorld, SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { enableStatsRunner } from './AC-SC-stats-support.js';
import { uniqueSuffix } from './support/unique.js';
const testDb = useTestDb();

it('AC-SC-org-stats worker 登记、在岗缓存包含行政下级、历史日零人数；主体撤权 blocked', async () => {
  const w = await successionWorld(testDb().db, 'sc-stats-worker');
  const root = await w.org('统计根');
  const child = await w.org('下级', root.id, { isVirtual: true });
  await w.hire('在岗甲', { departmentId: root.id });
  await w.hire('在岗乙', { departmentId: child.id });
  await enableStatsRunner(w);
  expect(
    (await w.call('PUT', 'settings/succession.hide_virtual_org', { ifMatch: 0, body: { value: true } })).status,
  ).toBe(200);
  expect(
    (await w.call('PUT', 'settings/succession.show_incumbents', { ifMatch: 0, body: { value: false } })).status,
  ).toBe(200);
  const id = await w.asTenant((tx) =>
    enqueueCalcRun(
      tx,
      {
        tenantId: w.tenant.id,
        kind: 'org_stats',
        trigger: 'manual',
        commandId: randomUUID(),
        requestedBy: w.user.id,
        businessDate: SC_TODAY,
        objects: [{ objectType: 'org', objectId: root.id }],
      },
      SC_NOW,
    ),
  );
  expect(SUCCESSION_CALC_KINDS.some((h) => h.kind === 'org_stats')).toBe(true);
  expect(await runCalcPage(w.db, w.tenant.id, id, undefined, SC_NOW)).toBe('succeeded');
  const cached = () =>
    w.asTenant(async (tx) =>
      rowsOf<{ on_duty_count: number }>(
        await tx.execute(sql`SELECT on_duty_count FROM succession_org_stats WHERE org_id=${root.id}::uuid`),
      ),
    );
  expect(await cached()).toEqual([{ on_duty_count: 2 }]);
  expect(
    await w.asTenant((tx) =>
      readOnDutyCount(tx, {
        tenantId: w.tenant.id,
        orgId: root.id,
        asOf: SC_TODAY,
        runId: id,
        now: SC_NOW,
      }),
    ),
  ).toBe(2);
  expect(
    await w.asTenant((tx) =>
      readOnDutyCount(tx, {
        tenantId: w.tenant.id,
        orgId: root.id,
        asOf: '2026-09-30',
        runId: id,
        now: SC_NOW,
      }),
    ),
  ).toBe(0);
  expect(await runCalcPage(w.db, w.tenant.id, id)).toBe('succeeded');
  const next = await w.asTenant((tx) =>
    enqueueCalcRun(
      tx,
      {
        tenantId: w.tenant.id,
        kind: 'org_stats',
        trigger: 'manual',
        commandId: randomUUID(),
        requestedBy: w.user.id,
        businessDate: SC_TODAY,
        objects: [{ objectType: 'org', objectId: root.id }],
      },
      SC_NOW,
    ),
  );
  await w.asTenant((tx) =>
    tx.execute(sql`UPDATE permission_grants SET status='revoked'
    WHERE user_id=${w.user.id}::uuid`),
  );
  expect(await runCalcPage(w.db, w.tenant.id, next)).toBe('blocked');
});

it.each([
  ['America/Havana', '2026-11-01T04:30Z', '2026-11-01T05:30Z'],
  ['America/Chicago', '2026-11-01T06:30Z', '2026-11-01T07:30Z'],
  ['America/Santiago', '2026-09-06T04:30Z', '2026-09-07T03:00Z'],
])('AC-SC-org-stats %s：真实生产者复用槽键，重复调用、回拨/缺午夜与跨日', async (timezone, a, b) => {
  const w = await successionWorld(testDb().db, `sc-stats-slot-${uniqueSuffix()}`);
  await w.org('定时组织');
  const producer = SUCCESSION_PRODUCERS.find((p) => p.kind === 'org_stats');
  expect(producer).toBeDefined();
  for (const stamp of [a, a, b]) {
    const now = new Date(stamp);
    await w.asTenant((tx) => producer!.runTenant(tx, { id: w.tenant.id, timezone }, now));
  }
  const keys = await w.asTenant(async (tx) =>
    rowsOf<{ idempotency_key: string }>(
      await tx.execute(sql`SELECT idempotency_key FROM succession_calc_runs ORDER BY idempotency_key`),
    ),
  );
  const expected = [
    ...new Set(
      [a, b].map((stamp) => {
        const now = new Date(stamp),
          businessDate = tenantLocalDate(now, timezone);
        const slot = calcScheduleSlot({
          tenantId: w.tenant.id,
          kind: 'org_stats',
          trigger: 'schedule',
          commandId: 'slot',
          requestedBy: null,
          objects: [],
          businessDate,
          now,
          timezone,
          intervalHours: 4,
        });
        return `org_stats:schedule:${w.tenant.id}:${businessDate}:4h:${slot.slotIndex}`;
      }),
    ),
  ].sort();
  expect(keys.map((r) => r.idempotency_key)).toEqual(expected);
});

it('AC-SC-org-stats 绿化率取 SP-06；没有来源为 null，forbidden 不降级成成功', async () => {
  const w = await successionWorld(testDb().db, 'sc-stats-green');
  const org = await w.org('绿化率');
  await enableStatsRunner(w);
  const id = await w.asTenant((tx) =>
    enqueueCalcRun(
      tx,
      {
        tenantId: w.tenant.id,
        kind: 'org_stats',
        trigger: 'manual',
        commandId: randomUUID(),
        requestedBy: w.user.id,
        businessDate: SC_TODAY,
        objects: [{ objectType: 'org', objectId: org.id }],
      },
      SC_NOW,
    ),
  );
  const port = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
  expect(await runCalcPage(w.db, w.tenant.id, id, [createOrgStatsHandler(port)], SC_NOW)).toBe('succeeded');
  const row = await w.asTenant(async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT green_rate,
    green_source_project_id FROM succession_org_stats WHERE org_id=${org.id}::uuid`),
    ),
  );
  expect(row).toEqual([{ green_rate: null, green_source_project_id: null }]);
  const forbidden = await w.asTenant((tx) =>
    enqueueCalcRun(
      tx,
      {
        tenantId: w.tenant.id,
        kind: 'org_stats',
        trigger: 'manual',
        commandId: randomUUID(),
        requestedBy: w.user.id,
        businessDate: SC_TODAY,
        objects: [{ objectType: 'org', objectId: org.id }],
      },
      SC_NOW,
    ),
  );
  expect(
    await runCalcPage(
      w.db,
      w.tenant.id,
      forbidden,
      [
        createOrgStatsHandler({
          greenRate: async () =>
            new Map([[org.id, { status: 'forbidden', green: 0, placed: 0, rate: null, source: null }]]),
        }),
      ],
      SC_NOW,
    ),
  ).toBe('partial');
  expect(
    await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT code FROM succession_calc_run_failures
    WHERE run_id=${forbidden}::uuid`),
      ),
    ),
  ).toEqual([{ code: 'SOURCE_FORBIDDEN' }]);
});
