/**
 * R2-T09b ③ DT-R5 未转交清空（规格 `30` “强校验实测”）：离职 / 退休落地时仍持有、又没有接收人的职责被清空——
 * 组织角色从生效日起产生清空该角色的组织新版本，下属直线 / 虚线上级置空；写转交记录（来源 2 离职 / 4 退休，接收人为空），
 * 检查离职退休人员列表据此列出；已有接收人的职责照常转交，不被清空。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { sql } from '@italent/db';
import { dutyExitWorld, smallerSubordinateWorld, TODAY, type ExitKind } from './AC-DT-exit-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, label, TODAY);
const EFFECTIVE = '2026-10-21';
const SOURCE = { leave: 2, retirement: 4 } as const;

describe.each(['leave', 'retirement'] as const satisfies readonly ExitKind[])('DT-R5 %s 落地清空', (kind) => {
  it('组织负责人与下属上级被清空，写来源记录，检查离职退休人员列出', async () => {
    const x = await world(`clear-${kind}`);
    const org = await x.headedOrg('合成负责人组织');
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const exit = await x.approvedApplication(kind, '2026-10-20', TODAY);

    expect(await x.activate(exit.id, EFFECTIVE)).toMatchObject({ outcome: 'effective' });

    const versions = await x.orgVersions(org.id);
    expect(versions.at(-1)).toEqual({ start: EFFECTIVE, head: null });
    expect(await x.headAt(org.id, '2026-10-20')).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, EFFECTIVE)).toBeNull();

    const records = await x.exitRecords();
    expect(records).toHaveLength(2);
    for (const row of records)
      expect(row).toMatchObject({ source: SOURCE[kind], status: 0, receiverId: null, employeeId: x.employee.id });
    expect(records.map((row) => row.dutyType).sort()).toEqual([1, 2]);

    x.setNow(`${EFFECTIVE}T02:00:00Z`);
    const listed = await x.departed();
    expect(listed.items).toEqual([expect.objectContaining({ employeeId: x.employee.id, kind, dutyCount: 2 })]);
  });

  it('清空只发生一次：之后再跑定时任务不产生新记录或新组织版本', async () => {
    const x = await world(`clear-once-${kind}`);
    const org = await x.headedOrg('合成负责人组织');
    const exit = await x.approvedApplication(kind, '2026-10-20', TODAY);
    await x.activate(exit.id, EFFECTIVE);
    const [records, versions] = [await x.exitRecords(), await x.orgVersions(org.id)];
    await x.runScheduler('2026-10-22T02:00:00Z');
    await x.runScheduler('2026-10-23T02:00:00Z');
    expect(await x.exitRecords()).toEqual(records);
    expect(await x.orgVersions(org.id)).toEqual(versions);
  });

  it('没有职责的人落地：不写记录、不产生组织版本，也不在检查列表里', async () => {
    const x = await world(`clear-none-${kind}`);
    const exit = await x.approvedApplication(kind, '2026-10-20', TODAY);
    await x.activate(exit.id, EFFECTIVE);
    expect(await x.exitRecords()).toEqual([]);
    x.setNow(`${EFFECTIVE}T02:00:00Z`);
    expect((await x.departed()).items).toEqual([]);
  });
});

describe('DT-R5 已有接收人的职责不被清空', () => {
  it('计划里的下属照常转交；计划外的组织角色被清空，各自留下对应记录', async () => {
    const x = await world('clear-mixed');
    const org = await x.headedOrg('合成负责人组织');
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const receiver = await x.peer('合成接收人');
    const exit = await x.approvedApplication('leave', '2026-10-20', TODAY);
    await x.planDuties(exit.id, [{ employeeId: subordinate.id, receiverId: receiver.id }]);

    expect(await x.activate(exit.id, EFFECTIVE)).toMatchObject({ outcome: 'effective' });

    expect(await x.managerOf(subordinate.id, EFFECTIVE)).toBe(receiver.id);
    expect((await x.orgVersions(org.id)).at(-1)).toEqual({ start: EFFECTIVE, head: null });
    const records = await x.exitRecords();
    expect(records.map((row) => [row.dutyType, row.status, row.receiverId])).toEqual(
      expect.arrayContaining([
        [2, 1, receiver.id],
        [1, 0, null],
      ]),
    );
    expect(records).toHaveLength(2);
  });

  it('全部职责都有接收人：落地后既无清空记录，也不在检查列表里', async () => {
    const x = await world('clear-all-planned');
    const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
    const receiver = await x.peer('合成接收人');
    const exit = await x.approvedApplication('leave', '2026-10-20', TODAY);
    await x.planDuties(exit.id, [{ employeeId: subordinate.id, receiverId: receiver.id }]);
    await x.activate(exit.id, EFFECTIVE);
    expect((await x.exitRecords()).filter((row) => row.status === 0)).toEqual([]);
    x.setNow(`${EFFECTIVE}T02:00:00Z`);
    expect((await x.departed()).items).toEqual([]);
  });
});

const worldWithSmallerSubordinate = (label: string) => smallerSubordinateWorld(world, label);

describe('P2-2 清空下属不得因预锁计划变化失败', () => {
  it('下属当前任职来自已生效调动、UUID 小于经理：上级被清空，清空记录无锁计划失败', async () => {
    const { x, subordinate } = await worldWithSmallerSubordinate('clear-lock-order');
    const fresh = await x.session.getEmployee(subordinate.id);
    await x.session.business(
      subordinate.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-15', fields: { departmentId: x.to.id } },
      fresh.revision,
    );
    expect(await x.managerOf(subordinate.id, '2026-09-20')).toBe(x.employee.id);
    const exit = await x.approvedApplication('leave', '2026-10-20', TODAY);

    expect(await x.activate(exit.id, EFFECTIVE)).toMatchObject({ outcome: 'effective' });

    expect(await x.managerOf(subordinate.id, EFFECTIVE)).toBeNull();
    const failures = await x.sqlRows<{ code: string | null; subordinate: string }>(sql`
      SELECT failure_code AS code, subordinate_id::text AS subordinate FROM duty_transfer_records
      WHERE tenant_id=${x.tenantId} AND employee_id=${x.employee.id}::uuid AND duty_type=2
        AND subordinate_id=${subordinate.id}::uuid`);
    expect(failures).toEqual([{ code: null, subordinate: subordinate.id }]);
  });
});
