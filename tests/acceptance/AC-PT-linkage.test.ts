/**
 * BE-7 PT-7（docs/08_设计/R2-T05_兼职设计.md §4.8，DEC-634，PB-57 改正例）：兼职“是否部门负责人”“新增下属”开闸，服务层 + 定时生效。
 * - 开始日 ≤ 今天：保存的同一事务里把员工设为兼职部门负责人 / 改下属直线经理（复用调动联动的组织写入与任职编辑，不复用调动入口）；
 * - 开始日 > 今天：写待执行事件（employment_outbox，不建表），开始日由定时生效执行；重复触发不重复改；
 * - 执行时兼职已结束 / 联动人员不可用：整单跳过并留可查事件，不报错、不留半套；
 * - 兼职结束、批量结束都不自动撤销负责人 / 下属关系（原站未验证）；false / 空数组不是联动请求，不留任何事件。
 * 日期框架：今天 2026-10-01，兼职默认 09-01 起。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { LINKED, linkageWorld, PENDING, SKIPPED } from './AC-PT-linkage-support.js';

const database = useTestDb();
const world = (label: string) => linkageWorld(database().db, label);

describe('开始日 ≤ 今天：保存同事务内执行', () => {
  it('是否部门负责人 = 是：兼职员工成为兼职部门负责人（生效日 = 兼职开始日），记录保存标志，留联动审计', async () => {
    const w = await world('head-now');
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    const created = await w.create({ isDepartmentHead: true });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect(await w.events(created.id)).toMatchObject({ 'employment.part_time.create': 1, [LINKED]: 1 });
    expect(await w.events(created.id)).not.toHaveProperty(PENDING);
    expect(await w.stored(created.id)).toEqual({ head: true, subordinates: null });
  });

  it('新增下属：下属当前任职的直线经理改为兼职员工，其余字段不变，也不触发向后更新', async () => {
    const w = await world('sub-now');
    const sub = await w.subordinate();
    const before = await w.managerOf(sub);
    const created = await w.create({ addedSubordinateIds: [sub] });
    const after = await w.managerOf(sub);
    expect(after.directManagerId).toBe(w.employeeId);
    expect({ ...after, directManagerId: null }).toEqual({ ...before, directManagerId: null });
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    expect(await w.events(created.id)).toMatchObject({ [LINKED]: 1 });
  });

  it('联动人员不合格（本人 / 不存在 / 不在职）：整单拒绝，兼职不保存，负责人与下属都不动', async () => {
    const w = await world('ineligible');
    const sub = await w.subordinate();
    const before = await w.writes();
    for (const addedSubordinateIds of [[w.employeeId], [sub, w.employeeId], ['00000000-0000-4000-8000-0000000000aa']]) {
      const error = await w.rejection({ isDepartmentHead: true, addedSubordinateIds });
      expect(error.code, JSON.stringify(addedSubordinateIds)).toBe('VALIDATION_FAILED');
    }
    expect(await w.writes()).toEqual(before);
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    expect((await w.managerOf(sub)).directManagerId).toBeNull();
  });

  it('false / 空数组不是联动请求：不执行、不留任何联动事件', async () => {
    const w = await world('no-linkage');
    const created = await w.create({ isDepartmentHead: false, addedSubordinateIds: [] });
    expect(await w.events(created.id)).toEqual({ 'employment.part_time.create': 1 });
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
  });

  it('已结束的补录（结束日早于今天）：不执行，留跳过事件 ENDED，兼职照常保存', async () => {
    const w = await world('backfill-ended');
    const created = await w.create({ isDepartmentHead: true, startDate: '2026-08-01', endDate: '2026-08-31' });
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    expect(await w.events(created.id)).toMatchObject({ [SKIPPED]: 1 });
    expect(await w.skipReasons(created.id)).toEqual(['ENDED']);
  });

  it('兼职结束、批量结束都不自动撤销负责人 / 下属关系（HR 用职责转交处理）', async () => {
    const w = await world('no-revoke');
    const sub = await w.subordinate();
    const created = await w.create({ isDepartmentHead: true, addedSubordinateIds: [sub] });
    await w.endTerm(created.id, 2, '2026-09-30');
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub)).directManagerId).toBe(w.employeeId);
  });
});

describe('开始日 > 今天：写待执行事件，开始日由定时生效执行', () => {
  const FUTURE = '2026-10-10';

  it('保存时只写 pending；开始日前扫描不执行；开始日当天执行一次，之后重复触发不再改', async () => {
    const w = await world('future');
    const sub = await w.subordinate();
    const created = await w.create({ startDate: FUTURE, isDepartmentHead: true, addedSubordinateIds: [sub] });
    expect(await w.events(created.id)).toMatchObject({ [PENDING]: 1 });
    expect(await w.events(created.id)).not.toHaveProperty(LINKED);
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    expect((await w.managerOf(sub)).directManagerId).toBeNull();

    expect((await w.sweep('2026-10-09')).errors).toEqual([]);
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();

    const versions = await w.orgVersions(w.partTimeOrg.id);
    const run = await w.sweep(FUTURE);
    expect(run.errors).toEqual([]);
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
    expect((await w.managerOf(sub, FUTURE)).directManagerId).toBe(w.employeeId);
    expect(await w.events(created.id)).toMatchObject({ [PENDING]: 1, [LINKED]: 1 });
    expect(await w.orgVersions(w.partTimeOrg.id)).toBe(versions + 1);

    await w.sweep(FUTURE);
    await w.sweep('2026-10-11');
    expect(await w.events(created.id)).toMatchObject({ [LINKED]: 1 });
    expect(await w.orgVersions(w.partTimeOrg.id)).toBe(versions + 1);
  });

  it('到期时兼职已结束（离职钩子把未开始的兼职结束成空区间）：跳过并留事件 ENDED，不报错、不改负责人 / 下属', async () => {
    const w = await world('future-ended');
    const sub = await w.subordinate();
    const created = await w.create({ startDate: FUTURE, isDepartmentHead: true, addedSubordinateIds: [sub] });
    await w.endTerm(created.id, 2, '2026-10-09');
    const run = await w.sweep(FUTURE);
    expect(run.errors).toEqual([]);
    expect(await w.headOf(w.partTimeOrg.id)).toBeNull();
    expect((await w.managerOf(sub, FUTURE)).directManagerId).toBeNull();
    expect(await w.skipReasons(created.id)).toEqual(['ENDED']);
    await w.sweep('2026-10-11');
    expect(await w.skipReasons(created.id)).toEqual(['ENDED']);
  });

  it('到期时联动人员已不合格（下属已离职）：整单跳过（负责人也不设），事件带机读原因，不卡队列', async () => {
    const w = await world('future-rejected');
    const sub = await w.subordinate();
    const other = await w.create({ startDate: FUTURE, isDepartmentHead: true });
    const created = await w.create({ startDate: FUTURE, addedSubordinateIds: [sub] });
    const revision = (await w.getEmployee(sub)).revision;
    await w.business(sub, { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-30' }, revision);
    const run = await w.sweep(FUTURE);
    expect(run.errors).toEqual([]);
    expect(await w.skipReasons(created.id)).toEqual(['TRANSFER_PERSON_NOT_ELIGIBLE']);
    expect(await w.events(created.id)).not.toHaveProperty(LINKED);
    // 同一员工名下另一条兼职的联动不受影响
    expect(await w.events(other.id)).toMatchObject({ [LINKED]: 1 });
    expect(await w.headOf(w.partTimeOrg.id)).toBe(w.employeeId);
  });

  it('未联动的未来兼职不写 pending，扫描也不动它', async () => {
    const w = await world('future-plain');
    const created = await w.create({ startDate: FUTURE });
    expect(await w.events(created.id)).toEqual({ 'employment.part_time.create': 1 });
    expect((await w.sweep(FUTURE)).errors).toEqual([]);
    expect(await w.events(created.id)).toEqual({ 'employment.part_time.create': 1 });
  });
});
