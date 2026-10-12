import { randomUUID } from 'node:crypto';
import { eq, successionCalcRuns, successionCalcRunObjects } from '@italent/db';
import {
  type SuccessionLevelRow,
  type SyncNomination,
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
    const cleared = await w.call('PATCH', `employment/records/${person.recordId}`, {
      ifMatch: current.revision,
      body: { fields: { positionId: null, levelId: null, sequenceId: null } },
    });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const emptyPosition = (await read())[0]!;
    expect(emptyPosition.fields).toMatchObject({
      'employee.entry_date': SC_TODAY,
      'employment.org_id': org.id,
      'employment.position_id': null,
      'employment.job_level_id': null,
      'employment.job_sequence_id': null,
    });
    expect(member(emptyPosition)).toMatchObject({ ok: true, value: { kind: 'number', value: 1 } });
  });
});

async function metricWorld(label: string) {
  const w = await successionWorld(db().db, label),
    org = await w.org('度量回归组织');
  const person = await w.hire('合成度量员工', { departmentId: org.id });
  await enableHealthRunner(w);
  const frozen = await w.asTenant(async (tx) => {
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
    return { run: run!, object: object! };
  });
  return {
    w,
    org,
    person,
    async measure(port: HealthReads, row: SuccessionLevelRow) {
      return w.asTenant(async (tx) =>
        healthMetricReader(
          { tx, run: frozen.run, now: SC_NOW },
          frozen.object,
          await healthPrincipal(tx, w.tenant.id, false),
          port,
        )(row),
      );
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

function nomination(orgId: string, personId: string, readinessCode: string | null = null): SyncNomination {
  return {
    nominationId: randomUUID(),
    objectId: randomUUID(),
    employeeId: personId,
    kind: 'org',
    direction: 'successor',
    orgId,
    positionId: null,
    successorEmployeeId: personId,
    readinessId: null,
    readinessCode,
    sortNo: 1,
    createdAt: SC_NOW,
    syncEligible: true,
    formValues: {},
  };
}
describe('AC-SC-07 P2-3 字段过滤与去重回归', () => {
  it('P2-3：继任人数已保存过滤条件在计算及所有聚合分支中生效', async () => {
    const { w, org, person, measure } = await metricWorld('health-filter-number');
    await w.setHead(org, person);
    const entries = [nomination(org.id, person.id), nomination(org.id, person.id)];
    const port = Object.assign(createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id }), {
      readSuccessionEntries: async () => [
        {
          employeeId: null,
          orgId: org.id,
          positionId: null,
          status: 'value' as const,
          nominations: entries,
          source: null,
        },
      ],
    });
    const row = metricRow({
      fieldSource: 'succession',
      fieldCode: 'successor_count',
      measure: 'successor_count',
      filterOperator: 'eq',
      filterValues: [2],
      threshold: 1,
    });
    const saved = await w.request('POST', '/health-levels', {
      ifMatch: 0,
      body: {
        code: 'FILTER_TWO',
        name: '过滤后不命中',
        color: '#336699',
        rules: { expression: '1', rows: [row] },
      },
    });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect(await measure(port, row)).toEqual({ status: 'value', value: 0 });
    for (const kind of ['count', 'ratio', 'count_over_successors', 'count_over_incumbents'])
      expect(await measure(port, { ...row, measure: kind }), kind).toEqual({ status: 'value', value: 0 });
    expect(await measure(port, { ...row, measure: 'average' })).toEqual({ status: 'empty' });
    expect(await measure(port, { ...row, filterValues: [1] })).toEqual({ status: 'value', value: 1 });
    expect(await measure(port, { ...row, filterValues: [1], measure: 'count' })).toEqual({ status: 'value', value: 1 });
    const queued = await w.request('POST', '/maps/org/compute-health', { ifMatch: 0, body: {} });
    expect(queued.status).toBe(202);
    const { runId } = await queued.json();
    expect(await runCalcPage(w.db, w.tenant.id, runId, [createHealthHandler('org_health', port)], SC_NOW)).toBe(
      'succeeded',
    );
    const results = await (await w.request('GET', '/health-results')).json();
    expect(results.items.find((r: { orgId: string }) => r.orgId === org.id)).toMatchObject({ levelId: null });
  });
  it('P2-3：准备度过滤只执行一次，重复提名去重；空准备度与零提名区分', async () => {
    const { w, org, person, measure } = await metricWorld('health-filter-readiness');
    let entries = [
      nomination(org.id, person.id, 'READY'),
      nomination(org.id, person.id, 'READY'),
      nomination(org.id, person.id, 'LATER'),
    ];
    const port = Object.assign(createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id }), {
      readSuccessionEntries: async () => [
        {
          employeeId: null,
          orgId: org.id,
          positionId: null,
          status: 'value' as const,
          nominations: entries,
          source: null,
        },
      ],
    });
    const row = metricRow({
      fieldSource: 'succession',
      fieldCode: 'readiness_code',
      measure: 'successor_count',
      filterOperator: 'eq',
      filterValues: ['READY'],
    });
    expect(await measure(port, row)).toEqual({ status: 'value', value: 1 });
    expect(await measure(port, { ...row, measure: 'count' })).toEqual({ status: 'value', value: 1 });
    expect(await measure(port, { ...row, filterValues: ['NEVER'] })).toEqual({ status: 'value', value: 0 });
    entries = [nomination(org.id, person.id)];
    expect(await measure(port, row)).toEqual({ status: 'empty' });
    entries = [];
    expect(await measure(port, row)).toEqual({ status: 'value', value: 0 });
    expect(
      await measure(port, { ...row, fieldCode: 'successor_count', filterOperator: null, filterValues: [] }),
    ).toEqual({ status: 'value', value: 0 });
  });
});

// 两组长矩阵各含数十次真实 PG 当前主体／人口读取；多窗口负载下超过 30s，仅这两组给 120s。
describe('AC-SC-07 同类度量矩阵', () => {
  it('P2-2/3：盘点六度量共用五态、过滤与分母；真实零不变 empty', async () => {
    const { w, org, person, measure } = await metricWorld('health-review-matrix');
    const second = await w.hire('合成第二成员', { departmentId: org.id });
    await w.setHead(org, person);
    let field: FieldRead = { status: 'value', value: 2 };
    const port = Object.assign(reviewPort(w.tenant.id, person.id, field), {
      readReviewFields: async () =>
        new Map([
          [person.id, { values: { score: field }, source: null }],
          [second.id, { values: { score: { status: 'empty' as const, value: null } }, source: null }],
        ]),
      readSuccessionEntries: async () => [
        {
          employeeId: null,
          orgId: org.id,
          positionId: null,
          status: 'value' as const,
          nominations: [nomination(org.id, person.id)],
          source: null,
        },
      ],
    });
    for (const kind of measures) {
      const row = metricRow({
        fieldSource: 'review',
        fieldCode: 'score',
        measure: kind,
        filterOperator: 'eq',
        filterValues: [2],
      });
      const expected = {
        count: 1,
        average: 2,
        ratio: 0.5,
        review_result_ratio: 1,
        count_over_successors: 1,
        count_over_incumbents: 1,
      }[kind];
      expect(await measure(port, row), kind).toEqual({ status: 'value', value: expected });
      for (const status of ['forbidden', 'unavailable'] as const) {
        field = { status, value: null };
        expect(await measure(port, row), `${kind}/${status}`).toEqual({ status });
      }
      field = { status: 'value', value: 2 };
    }
    expect(
      await measure(
        port,
        metricRow({
          fieldSource: 'review',
          fieldCode: 'score',
          measure: 'average',
          filterOperator: 'is_empty',
          filterValues: [],
        }),
      ),
    ).toEqual({ status: 'empty' });
    field = { status: 'value', value: 0 };
    expect(await measure(port, metricRow({ fieldSource: 'review', fieldCode: 'score', measure: 'average' }))).toEqual({
      status: 'value',
      value: 0,
    });
    expect(
      await measure(
        port,
        metricRow({
          fieldSource: 'review',
          fieldCode: 'score',
          measure: 'count',
          filterOperator: 'gt',
          filterValues: [0],
        }),
      ),
    ).toEqual({ status: 'value', value: 0 });
    expect(
      await measure(
        port,
        metricRow({
          fieldSource: 'review',
          fieldCode: 'score',
          population: 'successors',
          measure: 'count_over_incumbents',
        }),
      ),
    ).toEqual({ status: 'value', value: 1 });
  }, 120_000);
  it('P2-2/3：绿化率直接度量与字段度量共用五态，缺来源与空率区分', async () => {
    const { w, org, measure } = await metricWorld('health-green-matrix');
    let rate: number | null = null,
      status: 'value' | 'forbidden' | 'unavailable' = 'value',
      present = true;
    const port = Object.assign(createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id }), {
      greenRate: async () => new Map(present ? [[org.id, { status, rate, placed: 0, green: 0, source: null }]] : []),
    });
    for (const row of [
      metricRow({ fieldCode: null, measure: 'green_rate' }),
      metricRow({ fieldCode: 'green_rate', measure: 'average' }),
      metricRow({ fieldCode: 'green_rate', measure: 'count' }),
      metricRow({ fieldCode: 'green_rate', measure: 'ratio' }),
    ]) {
      expect(await measure(port, row)).toEqual({ status: 'empty' });
      rate = 0;
      expect(await measure(port, row)).toEqual({
        status: 'value',
        value: row.measure === 'count' || row.measure === 'ratio' ? 1 : 0,
      });
      for (const failed of ['forbidden', 'unavailable'] as const) {
        status = failed;
        expect(await measure(port, row)).toEqual({ status: failed });
      }
      status = 'value';
      present = false;
      expect(await measure(port, row)).toEqual({ status: 'unavailable' });
      present = true;
      rate = null;
    }
  });
  it('P2-2/3：继任五态覆盖人数和准备度；空人口与零分母仍 empty', async () => {
    const { w, org, person, measure } = await metricWorld('health-nomination-states');
    let status: 'value' | 'forbidden' | 'unavailable' | 'module_absent' = 'value';
    const port = Object.assign(createInMemoryTalentReviewSyncPort({ tenantId: w.tenant.id }), {
      readSuccessionEntries: async () => [
        {
          employeeId: null,
          orgId: org.id,
          positionId: null,
          status,
          nominations: [nomination(org.id, person.id, 'READY')],
          source: null,
        },
      ],
    });
    for (const code of ['successor_count', 'readiness_code'])
      for (const kind of ['count', 'successor_count', 'ratio', 'count_over_successors', 'count_over_incumbents'])
        for (const failure of ['forbidden', 'unavailable', 'module_absent'] as const) {
          status = failure;
          expect(await measure(port, metricRow({ fieldSource: 'succession', fieldCode: code, measure: kind }))).toEqual(
            { status: failure },
          );
        }
    status = 'value';
    expect(await measure(port, metricRow({ fieldCode: null, population: 'incumbents', measure: 'count' }))).toEqual({
      status: 'empty',
    });
    expect(
      await measure(
        port,
        metricRow({ fieldSource: 'succession', fieldCode: 'successor_count', measure: 'count_over_incumbents' }),
      ),
    ).toEqual({ status: 'empty' });
  }, 120_000);
});
