/** F-480 影响面检查：入职日期被转正日覆盖后，各读取口径的取值（每项对应结果文件“影响面检查”一节）。 */
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { entriesFrom } from '../../apps/api/src/modules/analytics/hr-dashboard.js';
import { boardClient, structureWorld } from './AC-HA-13a-support.js';

const db = useTestDb();

async function regularizedWorld(label: string, correction?: number) {
  const w = await structureWorld(db().db, label);
  const org = await w.org('合成实习转正部门');
  const e = await w.session.employee('合成实习生');
  const hire = await w.session.business(
    e.id,
    {
      kind: 'hire',
      mode: 'direct',
      effectiveDate: '2025-01-01',
      fields: {
        employType: 'intern',
        departmentId: org.id,
        ...(correction === undefined ? {} : { workYearCompanyBefore: correction }),
      },
    },
    e.revision,
  );
  const reg = await w.session.business(
    e.id,
    { kind: 'intern_regularization', mode: 'direct', effectiveDate: '2026-10-01', fields: { departmentId: org.id } },
    hire.employeeRevision,
  );
  return { w, org, e, hire, reg };
}

it('AC-EMP-F480-10：花名册入职日期列 = 转正日；累计司龄 = (asOf − 转正日)/365 + 校正值，与连续计算相同、不重复累计', async () => {
  const { w, e } = await regularizedWorld('roster');
  const c = boardClient(db().db, w.who);
  const response = await c.get('/api/tenant/hr-analysis/roster?asOf=2027-10-01');
  expect(response.status, await response.clone().text()).toBe(200);
  const items = ((await response.json()) as { items: Record<string, unknown>[] }).items;
  // 2025-01-01 → 2027-10-01 共 1003 天 = 2.74 年；转正后 365 天 = 1.0 + 校正值 1.7 = 2.7
  expect(items).toContainEqual(
    expect.objectContaining({ employeeId: e.id, entryDate: '2026-10-01', companyTenureYears: '2.7' }),
  );
});

it('AC-EMP-F480-11：任职记录列表与详情——实习段保留原入职日，转正段起为转正日并带实习开始日', async () => {
  const { w, e, hire, reg } = await regularizedWorld('records');
  const list = await w.session.records(e.id);
  expect(list.map((r) => [r.id, r.entryDate, r.effectiveDate])).toEqual([
    [hire.id, '2025-01-01', '2025-01-01'],
    [reg.id, '2026-10-01', '2026-10-01'],
  ]);
  const detail = await w.session.record(reg.id);
  expect(detail).toMatchObject({ entryDate: '2026-10-01', traineeStartDate: '2025-01-01' });
  const history = await w.session.record(hire.id, '2025-06-01');
  expect(history).toMatchObject({ entryDate: '2025-01-01' });
});

it('AC-EMP-F480-12：人员档案读取——入职日期 = 转正日（当前任职），首次入职日期保留实习开始日', async () => {
  const { w, e } = await regularizedWorld('personnel');
  const response = await w.call('GET', `/api/tenant/personnel/employees/${e.id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    entryDate: '2026-10-01',
    latestEntryDate: '2026-10-01',
    firstEntryDate: '2025-01-01',
  });
});

it('AC-EMP-F480-13：看板入职指标——转正记录不是入职类（ENTRY_KINDS），不重复计入；转正改入职日不改变口径（实习入职仍按实习开始日计入，转正日不计第二次）', async () => {
  const { w, hire, reg } = await regularizedWorld('entries');
  const ids = (since?: string) =>
    w
      .sqlRows<{ id: string }>(
        sql`SELECT r.id ${entriesFrom({ tenantId: w.tenantId, asOf: '2026-12-31' }, 'hired', since)}`,
      )
      .then((rows) => rows.map((r) => r.id));
  expect(await ids()).toEqual([hire.id]);
  expect(await ids('2025-01-01')).toEqual([hire.id]);
  expect(await ids('2026-10-01')).toEqual([]);
  expect([...(await ids()), ...(await ids('2025-01-01'))]).not.toContain(reg.id);
});

it('AC-EMP-F480-14：转正后离职沿用转正周期，离职记录与转正记录同周期（编制占用按时间轴连续，不重叠）', async () => {
  const { w, e, reg } = await regularizedWorld('leave');
  const revision = (await w.session.getEmployee(e.id)).revision;
  const leave = await w.session.business(e.id, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-12-31' }, revision);
  expect(leave.record?.staffId).toBe(reg.record?.staffId);
  const list = await w.session.records(e.id, '2027-01-02');
  expect(list.map((r) => r.kind)).toEqual(['hire', 'intern_regularization', 'leave']);
});
