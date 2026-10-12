import { randomUUID } from 'node:crypto';
import { eq, successionCalcRuns, successionCalcRunObjects } from '@italent/db';
import {
  type SuccessionLevelRow,
  type FieldRead,
  compilePopulation,
  evaluateFormula,
  inMemorySubject,
} from '@italent/domain';
import { describe, expect, it } from 'vitest';
import { successionWorld, SC_NOW, SC_TODAY } from './AC-SC-support.js';
import { useHealthDb, enableHealthRunner } from './AC-SC-07-health-support.js';
import { healthPeople } from '../../apps/api/src/modules/succession/health-population.js';

import { enqueueCalcRun, runCalcPage } from '../../apps/api/src/modules/succession/calc-worker.js';
import { createHealthHandler } from '../../apps/api/src/modules/succession/health-worker.js';
import { healthMetricReader, type HealthReads } from '../../apps/api/src/modules/succession/health-metrics.js';
import { healthPrincipal } from '../../apps/api/src/modules/succession/health-principal.js';
import { createInMemoryTalentReviewSyncPort } from '../../apps/api/src/modules/talent-review/sync-port-memory.js';

const db = useHealthDb();
describe('AC-SC-07 第 1 轮计算正确性回归', () => {
  it('P2-1：仅编辑任职备注，入职日期与自定义人群成员保持不变', async () => {
    const w = await successionWorld(db().db, 'health-entry-regression'),
      org = await w.org('入职日期人群'),
      position = await w.position(org.id, '人群职位'),
      person = await w.hire('合成人群成员', { departmentId: org.id, positionId: position.id });
    const read = () => w.asTenant((tx) => healthPeople(tx, w.tenant.id, org.id, SC_TODAY));
    const before = await read();
    const compiled = compilePopulation({
      expression: '1',
      rows: [
        {
          rowNo: 1,
          kind: 'field',
          field: {
            object: 'employee',
            code: 'entry_date',
            path: 'employee.entry_date',
            kind: 'date',
          },
          operator: 'eq',
          values: [SC_TODAY],
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error('人群编译失败');
    const member = (p: (typeof before)[number]) =>
      evaluateFormula(compiled.compiled.formula, {
        calendar: { today: SC_TODAY, timeZone: 'Asia/Shanghai' },
        subject: inMemorySubject(p.id, p.fields),
        fieldKind: () => 'date',
      });
    expect(member(before[0]!)).toMatchObject({ ok: true, value: { kind: 'number', value: 1 } });
    const record = await (await w.call('GET', `employment/records/${person.recordId}?asOf=${SC_TODAY}`)).json();
    const changed = await w.call('PATCH', `employment/records/${person.recordId}`, {
      ifMatch: record.revision,
      body: { fields: { remarks: '合成备注修改' } },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const current = await (await w.call('GET', `employment/records/${person.recordId}?asOf=${SC_TODAY}`)).json();
    expect(current.entryDate).toBe(SC_TODAY);
    const after = await read();
    expect(after[0]!.fields['employee.entry_date']).toBe(current.entryDate);
    expect(after).toEqual(before);
    expect(member(after[0]!)).toMatchObject({ ok: true, value: { kind: 'number', value: 1 } });
    expect(after[0]!.fields['employment.position_id']).toBe(position.id);
  });
});

async function metricWorld(label: string) {
  const w = await successionWorld(db().db, label),
    org = await w.org('度量回归组织');
  const person = await w.hire('合成度量员工', { departmentId: org.id });
  await enableHealthRunner(w);
  return {
    w,
    org,
    person,
    async measure(port: HealthReads, row: SuccessionLevelRow) {
      return w.asTenant(async (tx) => {
        const runId = await enqueueCalcRun(
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
        const [run] = await tx.select().from(successionCalcRuns).where(eq(successionCalcRuns.id, runId)),
          [object] = await tx.select().from(successionCalcRunObjects).where(eq(successionCalcRunObjects.runId, runId));
        return healthMetricReader(
          { tx, run: run!, now: SC_NOW },
          object!,
          await healthPrincipal(tx, w.tenant.id, false),
          port,
        )(row);
      });
    },
  };
}
const metricRow = (extra: Partial<SuccessionLevelRow>): SuccessionLevelRow => ({
  rowNo: 1,
  population: 'all',
  fieldSource: 'org',
  fieldCode: 'person_in_charge_id',
  measure: 'count',
  filterOperator: null,
  filterValues: [],
  comparator: 'eq',
  threshold: 0,
  thresholdHigh: null,
  isPercent: false,
  ...extra,
});
const measures = ['count', 'average', 'ratio', 'review_result_ratio', 'count_over_successors', 'count_over_incumbents'];
function reviewPort(tenantId: string, personId: string, value: FieldRead) {
  const port = createInMemoryTalentReviewSyncPort({
    tenantId,
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
  });
  return Object.assign(Object.create(port) as typeof port, {
    readReviewFields: async () => new Map([[personId, { values: { score: value }, source: null }]]),
  });
}
describe('AC-SC-07 P2-2 五态聚合回归', () => {
  it('P2-2：真实空字段在所有度量中保留 empty，普通比较不误命中', async () => {
    const { w, org, person, measure } = await metricWorld('health-empty-matrix');
    const port = reviewPort(w.tenant.id, person.id, { status: 'empty', value: null });
    const reads = Object.assign(port, {
      readSuccessionEntries: async () => [
        { employeeId: null, orgId: org.id, positionId: null, status: 'value' as const, nominations: [], source: null },
      ],
    });
    for (const kind of measures) {
      const row = metricRow({
        fieldSource: 'review',
        fieldCode: 'score',
        measure: kind,
        filterOperator: 'eq',
        filterValues: [0],
      });
      expect(await measure(reads, row), kind).toEqual({ status: 'empty' });
    }
    expect(await measure(reads, metricRow({}))).toEqual({ status: 'empty' });
  });
  it('P2-2：完整 HTTP 计算无负责人组织，不误命中等于零等级', async () => {
    const { w, org } = await metricWorld('health-empty-http');
    const reads = createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id });
    const saved = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        code: 'EMPTY_ZERO',
        name: '空值不命中',
        color: '#336699',
        rules: { expression: '1', rows: [metricRow({})] },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const queued = await w.request('POST', '/maps/org/compute-health', { ifMatch: 0, body: {} });
    expect(queued.status).toBe(202);
    const { runId } = await queued.json();
    expect(await runCalcPage(w.db, w.tenant.id, runId, [createHealthHandler('org_health', reads)], SC_NOW)).toBe(
      'succeeded',
    );
    const results = await (await w.request('GET', '/health-results')).json();
    expect(results.items.find((r: { orgId: string }) => r.orgId === org.id)).toMatchObject({ levelId: null });
  });
});
