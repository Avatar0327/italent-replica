/**
 * BE-12a / AC-HA-03：员工时点花名册——任职、合同、组织同时取 asOf 当天的版本（规格 35 §2.2）。
 * 固定夹具（租户今天 = 2026-10-06）：asOf 之后才发生的部门调动、合同续签、组织改名都不影响 asOf 的名册；
 * 另测 asOf 当天入职 / 当天最后工作日的边界、撤销离职后重新出现、筛选 / 分页 / 默认排序。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rosterWorld, ROSTER_HEADERS } from './AC-HA-roster-support.js';

const database = useTestDb();
const ASOF = '2025-07-01';

/** 集团 G → 研发部 R → 后端组 B（三级）；销售部 S 在 G 下（二级）。后端组 2026-01-01 改名“平台组”。 */
async function fixture(label: string) {
  const w = await rosterWorld(database().db, label);
  const group = await w.org('集团G');
  const rd = await w.org('研发部R', group);
  const backend = await w.org('后端组B', rd);
  const sales = await w.org('销售部S', group);
  const zhang = await w.hire('HA0002', '张三', '2025-01-01', backend, {
    gender: '男',
    birthday: '1990-07-02',
    workDate: '2012-07-01',
    mobilePhone: '13800000001',
    idNumber: '110101199007020011',
    email: 'zhangsan@example.com',
  });
  const first = await w.contract(zhang.id, { effectiveDate: '2025-01-01', endDate: '2025-12-31' });
  await w.contract(zhang.id, { effectiveDate: '2026-01-01', endDate: '2026-12-31' }, first);
  await w.session.business(
    zhang.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-03-01', fields: { departmentId: sales.id } },
    (await w.session.getEmployee(zhang.id)).revision,
  );
  await w.rename(backend, '平台组', '2026-01-01');
  return { w, group, rd, backend, sales, zhang };
}

describe('AC-HA-03 时点花名册：任职、合同、组织同取 asOf 当天', () => {
  it('asOf = 2025-07-01：部门 / 组织全称 / 合同都是该日的值（调动、续签、改名都在 asOf 之后）', async () => {
    const { w, zhang } = await fixture('ha03-asof');
    const past = await w.rosterOk(ASOF);
    expect(past.asOf).toBe(ASOF);
    expect(past.total).toBe(1);
    const row = past.items[0]!;
    expect(row).toMatchObject({
      employeeId: zhang.id,
      employeeName: '张三',
      code: 'HA0002',
      gender: '男',
      birthday: '1990-07-02',
      // 年龄 / 司龄 / 工龄按 asOf 计算：1990-07-02 出生，asOf 的次日才满 35 岁，故 asOf 时 34 岁
      age: 34,
      companyTenureYears: '0.4',
      workTenureYears: '13.0',
      entryDate: '2025-01-01',
      level: null,
      employeeStatus: 3,
      orgLevel1: '集团G',
      orgLevel2: '研发部R',
      orgLevel3: '后端组B',
      contractEffectiveDate: '2025-01-01',
      contractEndDate: '2025-12-31',
      contractTermType: 'fixed',
      contractTermMonths: 12,
    });
    // 组织全称取 asOf 当天各级上级的名称（改名“平台组”在 asOf 之后）
    expect(row['orgFullName']).toMatch(/集团G\/研发部R\/后端组B$/);
    expect(row['orgFullName']).not.toContain('平台组');
    expect(past.columns.map((column) => column.label)).toEqual(['姓名', '工号', ...ROSTER_HEADERS]);
  });

  it('asOf 缺省 = 租户今天：当前部门 / 改名后的组织名 / 续签后的合同；同一个人在不同 asOf 看到不同值', async () => {
    const { w, zhang } = await fixture('ha03-today');
    const today = await w.rosterOk(undefined);
    expect(today.asOf).toBe('2026-10-06');
    expect(today.items.find((item) => item.employeeId === zhang.id)).toMatchObject({
      employeeId: zhang.id,
      age: 36,
      orgLevel1: '集团G',
      orgLevel2: '销售部S',
      orgLevel3: null,
      contractEffectiveDate: '2026-01-01',
      contractEndDate: '2026-12-31',
    });
    // 调动前（asOf 之后才调到销售部）与改名生效当天：后端组已叫“平台组”
    const renamed = await w.rosterOk('2026-02-01');
    expect(renamed.items[0]).toMatchObject({ orgLevel3: '平台组', contractEffectiveDate: '2026-01-01' });
    expect(String(renamed.items[0]!['orgFullName'])).toMatch(/集团G\/研发部R\/平台组$/);
    // 未来日期合法：取当前已落地的未来版本
    const future = await w.rosterOk('2027-06-01');
    expect(future.items.find((item) => item.employeeId === zhang.id)).toMatchObject({
      orgLevel2: '销售部S',
      age: 36,
    });
  });

  it('asOf 不合法 400；没有任职的日期（入职前）名册为空', async () => {
    const { w } = await fixture('ha03-invalid');
    for (const bad of ['2025-02-30', '20250701', 'abc']) expect((await w.roster(bad)).status, bad).toBe(400);
    expect((await w.rosterOk('2024-12-31')).total).toBe(0);
  });
});

describe('AC-HA-03 名册人员范围：在职、内部员工 / 实习生，边界日与撤销', () => {
  it('asOf 当天入职算在职，前一天不算；最后工作日当天算在职，次日（离职生效日）不算', async () => {
    const w = await rosterWorld(database().db, 'ha03-edge');
    const dept = await w.org('边界部门');
    await w.hire('HB0001', '当天入职', '2025-07-01', dept);
    const leaver = await w.hire('HB0002', '最后工作日', '2025-01-01', dept);
    await w.effectiveExit(leaver.id, '2025-07-01');

    expect(w.codes(await w.rosterOk('2025-06-30'))).toEqual(['HB0002']);
    const onDay = await w.rosterOk('2025-07-01');
    expect(w.codes(onDay)).toEqual(['HB0001', 'HB0002']);
    // 最后工作日 = asOf 的人仍在职，名册带出他的最后工作日
    expect(onDay.items.find((item) => item.code === 'HB0002')).toMatchObject({ lastWorkDate: '2025-07-01' });
    expect(onDay.items.find((item) => item.code === 'HB0001')).toMatchObject({ lastWorkDate: null });
    expect(w.codes(await w.rosterOk('2025-07-02'))).toEqual(['HB0001']);
  });

  it('离职撤销后按撤销后的时间轴重新出现在名册里；撤销前不在', async () => {
    const w = await rosterWorld(database().db, 'ha03-cancel');
    const dept = await w.org('撤销部门');
    const employee = await w.hire('HC0001', '将被撤销', '2025-01-01', dept);
    const exit = await w.effectiveExit(employee.id, '2025-07-01');
    expect(w.codes(await w.rosterOk('2025-08-01'))).toEqual([]);
    await w.cancelled(exit.id);
    const after = await w.rosterOk('2025-08-01');
    expect(w.codes(after)).toEqual(['HC0001']);
    expect(after.items[0]).toMatchObject({ lastWorkDate: null });
  });
});

describe('AC-HA-03 筛选、分页、默认排序', () => {
  it('默认按工号排序并分页；姓名 / 邮箱 / 参加工作日期 / 人员状态 / 雇佣关系筛选', async () => {
    const w = await rosterWorld(database().db, 'ha03-filter');
    const dept = await w.org('筛选部门');
    await w.hire('HD0003', '丙', '2025-01-01', dept, { workDate: '2015-03-01', email: 'bing@example.com' });
    await w.hire('HD0001', '甲', '2025-01-01', dept, { workDate: '2010-03-01', email: 'jia@example.com' });
    await w.hire('HD0002', '乙', '2025-01-01', dept, { workDate: '2012-03-01', email: 'yi@example.com' });

    const all = await w.rosterOk('2025-07-01');
    expect(w.codes(all)).toEqual(['HD0001', 'HD0002', 'HD0003']);
    expect(all.total).toBe(3);
    const second = await w.rosterOk('2025-07-01', 'pageSize=2&page=2');
    expect(w.codes(second)).toEqual(['HD0003']);
    expect(second.total).toBe(3);

    expect(w.codes(await w.rosterOk('2025-07-01', `name=${encodeURIComponent('乙')}`))).toEqual(['HD0002']);
    expect(w.codes(await w.rosterOk('2025-07-01', 'email=jia@example.com'))).toEqual(['HD0001']);
    expect(w.codes(await w.rosterOk('2025-07-01', 'workDateFrom=2011-01-01&workDateTo=2013-01-01'))).toEqual([
      'HD0002',
    ]);
    expect(w.codes(await w.rosterOk('2025-07-01', 'employeeStatus=2'))).toEqual([]);
    expect(w.codes(await w.rosterOk('2025-07-01', 'employeeStatus=3'))).toEqual(['HD0001', 'HD0002', 'HD0003']);
    expect(w.codes(await w.rosterOk('2025-07-01', 'employType=intern'))).toEqual([]);
    expect(w.codes(await w.rosterOk('2025-07-01', 'employType=internal'))).toHaveLength(3);
    for (const bad of ['employeeStatus=8', 'employType=external', 'workDateFrom=bad', 'pageSize=0'])
      expect((await w.roster('2025-07-01', bad)).status, bad).toBe(400);
  });
});
