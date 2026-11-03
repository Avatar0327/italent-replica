/** DEC-791② / DEC-793：看板、结构报表、流动报表与花名册共享累计司龄。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { boardClient, STRUCTURE_BASE, structureWorld } from './AC-HA-13a-support.js';
import { movementClient, movementWorld, MOVEMENT_BASE } from './AC-HA-13b-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
it('AC-HA-F432-01：当前快照校正值进入结构看板平均与分段、结构报表及花名册；撤权后花名册不泄露', async () => {
  const db = database().db;
  const w = await structureWorld(db, 'f432-structure');
  const org = await w.org('合成累计司龄部门');
  const e = await w.hire('合成累计司龄员工', { date: '2025-07-20', department: org });
  const [record] = await w.session.records(e.id);
  const edited = await w.session.request('PATCH', `/records/${record!.id}`, {
    ifMatch: (record as unknown as { revision: number }).revision,
    body: { fields: { workYearCompanyBefore: 2 } },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const c = boardClient(db, w.who);
  expect((await c.component(STRUCTURE_BASE, '6.03')).value).toBe(3.2);
  await c.expectCount(STRUCTURE_BASE, '6.08', [e.id], '', '2to5y');
  const report = await c.report('quality');
  expect(report.summary.cells).toMatchObject({ avgTenure: 3.2, 'tenure:2to5y': 1 });
  const roster = await c.get('/api/tenant/hr-analysis/roster?asOf=2026-10-01');
  expect(roster.status).toBe(200);
  expect(((await roster.json()) as { items: object[] }).items).toContainEqual(
    expect.objectContaining({ employeeId: e.id, companyTenureYears: '3.2' }),
  );
  const limited = tenantApi(db, { authorize: (q) => !q.fields?.includes('workYearCompanyBefore') });
  const response = await limited.request('GET', '/api/tenant/hr-analysis/roster?asOf=2026-10-01', {
    user: w.who.user,
    tenant: w.who.tenant,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: object[]; columns: { key: string }[] };
  expect(body.columns.map((c) => c.key)).not.toContain('companyTenureYears');
  expect(body.items[0]).not.toHaveProperty('companyTenureYears');
});

it('AC-HA-F432-02：离职以最后工作日冻结累计司龄，分段与流出报表一致，重聘后的新值不污染旧周期', async () => {
  const db = database().db;
  const w = await movementWorld(db);
  const org = await w.org('合成离职司龄部门');
  const e = await w.hire('合成离职司龄员工', '2025-01-01', org, { workYearCompanyBefore: 2 });
  await w.leave(e.id, '2026-01-01');
  const c = movementClient(db, w.who);
  const query = 'asOf=2026-10-06&year=2026';
  const distribution = await c.groups('6.31', query);
  expect(distribution.find((g) => g.key === '2to5y')?.count).toBe(1);
  const report = await c.report('outflow', query);
  expect(report.tables!.find((t) => t.key === 'sequences')!.summary.cells).toMatchObject({
    averageTenure: 3,
    'tenure:2to5y': 1,
  });
  const early = await w.hire('合成短期离职员工', '2026-09-01', org, { workYearCompanyBefore: 2 });
  await w.leave(early.id, '2026-09-15');
  // F-431 原始年数 <= 0.083 的阈值保留；校正后 2 年多不再属于短期离职。
  expect((await c.detail(MOVEMENT_BASE, '6.32', query)).ids).not.toContain(early.id);
  const revision = (await w.session.getEmployee(e.id)).revision;
  await w.session.business(
    e.id,
    {
      kind: 'rehire',
      mode: 'direct',
      effectiveDate: '2026-09-01',
      fields: { departmentId: org.id, employType: 'internal', workYearCompanyBefore: 9 },
    },
    revision,
  );
  const after = await c.report('outflow', query);
  expect(after.tables!.find((t) => t.key === 'sequences')!.summary.cells).toMatchObject({
    averageTenure: 2.5,
    'tenure:2to5y': 2,
  });
});
