import { randomUUID } from 'node:crypto';
import { sql, successionCalcRuns, successionCalcRunObjects } from '@italent/db';
import type { SuccessionLevelRow, SyncNomination } from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_TODAY, SC_NOW } from './AC-SC-support.js';
import { enableHealthRunner, useHealthDb } from './AC-SC-07-health-support.js';
import { rowsOf } from '../../apps/api/src/modules/succession/read-sql.js';
import { runCalcPage, enqueueCalcRun } from '../../apps/api/src/modules/succession/calc-worker.js';
import { healthMetricReader } from '../../apps/api/src/modules/succession/health-metrics.js';
import { healthPrincipal } from '../../apps/api/src/modules/succession/health-principal.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';
import { dispatchCalcJobs } from '../../apps/api/src/modules/succession/calc-jobs.js';
import { tenantApi } from './support/tenant-api.js';

const testDb = useHealthDb();
describe('AC-SC-07 组织健康度', () => {
  it('DEC-449 清除手工值保留行、原子恢复 computed，revision 递增', async () => {
    const w = await successionWorld(testDb().db, 'health-clear'),
      org = await w.org('清除健康度');
    for (const revision of [0, 1]) {
      const response = await w.request('PUT', `/health-results/${org.id}`, {
        ifMatch: revision,
        body: { levelId: null },
      });
      expect(response.status).toBe(200);
    }
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT level_id,method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
        ),
      ),
    ).toEqual([{ level_id: null, method: 'computed', revision: 2 }]);
  });
  it('系统主体在 app_user 事务中正常授权，暴露 worker blocked 的底层原因', async () => {
    const w = await successionWorld(testDb().db, 'health-principal');
    await enableHealthRunner(w);
    expect(await w.asTenant((tx) => healthPrincipal(tx, w.tenant.id, false))).toMatchObject({ userId: w.user.id });
  });
  it('当前范围为空时读不到结果，赋值和重置均 404 且不改原行', async () => {
    const w = await successionWorld(testDb().db, 'health-scope'),
      org = await w.org('范围外组织');
    expect((await w.request('PUT', `/health-results/${org.id}`, { ifMatch: 0, body: { levelId: null } })).status).toBe(
      200,
    );
    const before = await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`
      SELECT level_id,method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
      ),
    );
    const api = tenantApi(w.db, { authorize: async (q) => q.action !== 'data.scope.all', clock: () => SC_NOW });
    const as = { user: w.user.id, tenant: w.tenant.id };
    const read = await api.request('GET', '/api/tenant/succession/health-results', as);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ total: 0, items: [] });
    const assign = await api.request('PUT', `/api/tenant/succession/health-results/${org.id}`, {
      ...as,
      ifMatch: 1,
      body: { levelId: null },
    });
    const reset = await api.request('POST', '/api/tenant/succession/health-results/reset', {
      ...as,
      body: { items: [{ orgId: org.id, expectedRevision: 1 }] },
    });
    expect(assign.status).toBe(404);
    expect(reset.status).toBe(404);
    expect(await assign.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await reset.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT level_id,method,revision FROM succession_health_results WHERE org_id=${org.id}::uuid`),
        ),
      ),
    ).toEqual(before);
  });
  it('T04 替身：盘点数值、module_absent 与逐字段撤权不混淆', async () => {
    const w = await successionWorld(testDb().db, 'health-source'),
      org = await w.org('取数组织');
    const person = await w.hire('合成员工', { departmentId: org.id });
    await enableHealthRunner(w);
    const port = createInMemoryTalentReviewSyncPort({
      tenantId: w.tenant.id,
      fields: [
        {
          code: 'score',
          label: '分数',
          group: '盘点',
          kind: 'number',
          systemWritten: true,
          formulaUsable: true,
        },
      ],
      sources: [
        {
          projectId: randomUUID(),
          meetingId: null,
          code: 'P',
          status: 'in_progress',
          periodStartDate: SC_TODAY,
          periodEndDate: SC_TODAY,
          businessDate: SC_TODAY,
          objects: [
            {
              employeeId: person.id,
              orgId: org.id,
              fields: { score: { status: 'value', value: 0.35 } },
              succession: null,
            },
          ],
        },
      ],
    });
    await w.asTenant(async (tx) => {
      await enqueueCalcRun(
        tx,
        {
          tenantId: w.tenant.id,
          kind: 'org_health',
          trigger: 'manual',
          commandId: randomUUID(),
          requestedBy: w.user.id,
          businessDate: SC_TODAY,
          objects: [{ objectType: 'org', objectId: org.id }],
        },
        SC_NOW,
      );
      const [run] = await tx.select().from(successionCalcRuns),
        [object] = await tx.select().from(successionCalcRunObjects);
      const read = healthMetricReader(
        { tx, run: run!, now: SC_NOW },
        object!,
        await healthPrincipal(tx, w.tenant.id, false),
        port,
      );
      const row: SuccessionLevelRow = {
        rowNo: 1,
        population: 'all',
        fieldSource: 'review',
        fieldCode: 'score',
        measure: 'average',
        comparator: 'ge',
        threshold: 0.3,
        thresholdHigh: null,
        isPercent: true,
        filterOperator: null,
        filterValues: [],
      };
      expect(await read(row)).toEqual({ status: 'value', value: 0.35 });
      expect(await read({ ...row, fieldSource: 'succession', fieldCode: null, measure: 'successor_count' })).toEqual({
        status: 'module_absent',
      });
      const nominations: SyncNomination[] = [];
      const present = Object.assign(Object.create(port) as typeof port, {
        readSuccessionEntries: async () => [
          {
            employeeId: null,
            orgId: org.id,
            positionId: null,
            status: 'value' as const,
            nominations,
            source: null,
          },
        ],
      });
      const mapped = healthMetricReader(
        { tx, run: run!, now: SC_NOW },
        object!,
        await healthPrincipal(tx, w.tenant.id, false),
        present,
      );
      const count = { ...row, fieldSource: 'succession' as const, fieldCode: null, measure: 'successor_count' };
      expect(await mapped(count)).toEqual({ status: 'value', value: 0 });
      nominations.push({
        nominationId: randomUUID(),
        objectId: randomUUID(),
        employeeId: person.id,
        kind: 'org',
        direction: 'successor',
        orgId: org.id,
        positionId: null,
        successorEmployeeId: person.id,
        readinessId: null,
        readinessCode: null,
        sortNo: 1,
        createdAt: SC_NOW,
        syncEligible: true,
        formValues: {},
      });
      expect(await mapped({ ...count, population: 'incumbents' })).toEqual({ status: 'empty' });
      port.denyViewer(w.user.id, { fieldCodes: ['score'] });
      expect(await read(row)).toEqual({ status: 'forbidden' });
    });
  });
  it('计算冻结全部授权组织、原命令重放保留集合；缓存取数、手工保留、重置冲突逐对象拒绝', async () => {
    const w = await successionWorld(testDb().db, 'health');
    const root = await w.org('健康根'),
      child = await w.org('健康下级', root.id, { isVirtual: true });
    expect(
      (await w.call('PUT', 'settings/succession.hide_virtual_org', { ifMatch: 0, body: { value: true } })).status,
    ).toBe(200);
    await enableHealthRunner(w);
    const levelResponse = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        code: 'HEALTH',
        name: '满星',
        color: '#336699',
        enabled: true,
        rules: {
          expression: '1',
          rows: [
            {
              rowNo: 1,
              population: 'all',
              fieldSource: 'org',
              fieldCode: 'on_duty_count',
              measure: 'average',
              comparator: 'between',
              threshold: 7,
              thresholdHigh: 7,
            },
          ],
        },
      },
    });
    expect(levelResponse.status, await levelResponse.clone().text()).toBe(201);
    const level = (await levelResponse.json()) as { id: string };
    const assign = (org: string, revision: number, id = level.id) =>
      w.request('PUT', `/health-results/${org}`, {
        ifMatch: revision,
        body: { levelId: id },
      });
    expect((await assign(child.id, 0)).status).toBe(200);
    const options = { ifMatch: 0, body: {}, idempotencyKey: randomUUID() };
    const compute = await w.request('POST', '/maps/org/compute-health', options);
    expect(compute.status, await compute.clone().text()).toBe(202);
    const { runId } = (await compute.json()) as { runId: string };
    await w.asTenant(async (tx) => {
      await tx.execute(sql`INSERT INTO succession_org_stats
        (tenant_id,org_id,stat_date,on_duty_count,slot_key,computed_at,run_id)
        VALUES (${w.tenant.id}::uuid,${root.id}::uuid,${SC_TODAY}::date,7,'cached',
          ${SC_NOW.toISOString()}::timestamptz,${runId}::uuid)`);
    });
    await w.org('排队后新组织');
    expect(await (await w.request('POST', '/maps/org/compute-health', options)).json()).toEqual({ runId });
    const frozen = await w.asTenant(async (tx) =>
      rowsOf<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id FROM succession_calc_run_objects
          WHERE run_id=${runId}::uuid`),
      ),
    );
    expect(frozen.map((r) => r.object_id).sort()).toEqual([w.tenant.id, root.id, child.id].sort());
    const { createHealthHandler } = await import('../../apps/api/src/modules/succession/health-worker.js');
    const port = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
    expect(await runCalcPage(w.db, w.tenant.id, runId, [createHealthHandler('org_health', port)], SC_NOW)).toBe(
      'succeeded',
    );
    const read = async () =>
      (await (await w.request('GET', '/health-results')).json()) as {
        items: { orgId: string; levelId: string | null; method: string; revision: number }[];
      };
    const before = await read();
    expect(before.items.find((r) => r.orgId === root.id)).toMatchObject({
      levelId: level.id,
      method: 'computed',
      revision: 1,
    });
    expect(before.items.find((r) => r.orgId === child.id)).toMatchObject({
      levelId: level.id,
      method: 'manual',
      revision: 1,
    });
    const reset = await w.request('POST', '/health-results/reset', {
      body: {
        items: [
          { orgId: root.id, expectedRevision: 1 },
          { orgId: child.id, expectedRevision: 1 },
        ],
      },
    });
    expect(reset.status, await reset.clone().text()).toBe(202);
    const resetId = ((await reset.json()) as { runId: string }).runId;
    expect((await assign(child.id, 1)).status).toBe(200);
    expect(await runCalcPage(w.db, w.tenant.id, resetId, [createHealthHandler('org_health_reset', port)], SC_NOW)).toBe(
      'partial',
    );
    expect((await read()).items.find((r) => r.orgId === child.id)).toMatchObject({ method: 'manual', revision: 2 });
    expect((await read()).items.find((r) => r.orgId === root.id)).toMatchObject({ method: 'computed', revision: 2 });
    const failures = await w.asTenant(async (tx) =>
      rowsOf(
        await tx.execute(sql`SELECT code FROM succession_calc_run_failures
          WHERE run_id=${resetId}::uuid`),
      ),
    );
    expect(failures).toEqual([{ code: 'REVISION_CONFLICT' }]);
    const clearKey = randomUUID();
    const clear = await w.request('PUT', `/health-results/${child.id}`, {
      ifMatch: 2,
      body: { levelId: null },
      idempotencyKey: clearKey,
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ levelId: null, method: 'computed', revision: 3 });
    expect(
      await w.asTenant(async (tx) =>
        rowsOf(
          await tx.execute(sql`
      SELECT "before"->>'levelId' AS old_level,"after"->>'method' AS method FROM audit_events
      WHERE command_id=${clearKey} AND object_type='Succession.HealthResult'`),
        ),
      ),
    ).toEqual([{ old_level: level.id, method: 'computed' }]);
    const next = await w.request('POST', '/maps/org/compute-health', { ifMatch: 0, body: {} });
    expect(next.status).toBe(202);
    const nextId = ((await next.json()) as { runId: string }).runId;
    expect(await runCalcPage(w.db, w.tenant.id, nextId, [createHealthHandler('org_health', port)], SC_NOW)).toBe(
      'succeeded',
    );
    expect((await read()).items.find((r) => r.orgId === child.id)).toMatchObject({ method: 'computed', revision: 4 });
    const count = await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`)));
    await dispatchCalcJobs({ db: w.db, clock: () => SC_NOW }, { kind: 'org_health' });
    expect(
      await w.asTenant(async (tx) => rowsOf(await tx.execute(sql`SELECT id FROM succession_calc_runs`))),
    ).toHaveLength(count.length);
  });
});
