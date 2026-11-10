/**
 * R2-T09b DT-R5 第 2 轮 P2-1：转交计划里的部分职责在落地前已提前执行（审批通过时 / 指定日期到日），
 * 计划之外的下属仍须在落地时清空上级。清空预锁不得因“计划已有执行行”漏掉这些下属（UUID 小于经理时，漏锁即锁序失败）。
 * 三种时机各一条：approval_passed（节点通过当场执行）、specified_date（到日由定时任务执行）、business_effective（落地时执行）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dutyExitWorld, smallerSubordinateWorld, TODAY, type ExitKind } from './AC-DT-exit-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, label, TODAY);
const LAST = '2026-10-20';
const EFFECTIVE = '2026-10-21';
const DUE = '2026-10-12';
const SOURCE = { leave: 2, retirement: 4 } as const;

/** 经理 M 担任组织负责人（计划转给 R）；下属 S 的 UUID 小于 M、不在计划里。 */
async function partialPlanWorld(label: string) {
  const { x, subordinate } = await smallerSubordinateWorld(world, label);
  const org = await x.headedOrg('合成负责人组织');
  const receiver = await x.peer('合成接收人');
  const plan = x.plan({ orgRoles: [{ orgId: org.id, receiverId: receiver.id }] });
  return { x, subordinate, org, receiver, plan };
}

type World = Awaited<ReturnType<typeof partialPlanWorld>>;

/** 落地后：整单生效、S 上级被清空、组织负责人归 R，转交记录一条已完成（R）、一条清空（无接收人、无失败）。 */
async function expectLanded(w: World, exitId: string, kind: ExitKind, orgFrom: string) {
  const { x, subordinate, org, receiver } = w;
  expect(await x.activate(exitId, EFFECTIVE)).toMatchObject({ outcome: 'effective' });
  expect(await x.stateOfBusiness(exitId)).toBe('effective');
  expect(await x.managerOf(subordinate.id, EFFECTIVE)).toBeNull();
  expect(await x.headAt(org.id, orgFrom)).toBe(receiver.id);
  // 造 UUID 序场景时可能多造了几个同样不在计划里的下属：它们同样被清空，下面按 S 精确核对，其余只核口径
  const records = await x.exitRecords();
  const [orgRecords, subRecords] = [
    records.filter((row) => row.dutyType === 1),
    records.filter((r) => r.dutyType === 2),
  ];
  expect(orgRecords.map((row) => [row.status, row.receiverId, row.source])).toEqual([[1, receiver.id, SOURCE[kind]]]);
  expect(subRecords.length).toBeGreaterThan(0);
  for (const row of subRecords) expect(row).toMatchObject({ status: 0, receiverId: null, source: SOURCE[kind] });
  const cleared = await x.sqlRows<{ code: string | null; subordinate: string; date: string }>(sql`
    SELECT failure_code AS code, subordinate_id::text AS subordinate, transfer_date::text AS date
    FROM duty_transfer_records WHERE tenant_id=${x.tenantId} AND employee_id=${x.employee.id}::uuid
      AND duty_type=2 AND receiver_id IS NULL AND subordinate_id=${subordinate.id}::uuid`);
  expect(cleared).toEqual([{ code: null, subordinate: subordinate.id, date: EFFECTIVE }]);
  const failed = await x.sqlRows(sql`SELECT 1 FROM duty_transfer_records WHERE tenant_id=${x.tenantId}
    AND employee_id=${x.employee.id}::uuid AND failure_code IS NOT NULL`);
  expect(failed).toEqual([]);
}

describe.each(['leave', 'retirement'] as const satisfies readonly ExitKind[])(
  'P2-1 审批通过时已提前转交部分职责（%s）',
  (kind) => {
    it('计划外下属 S（UUID 小于经理）落地时上级被清空，无锁错误，整单生效', async () => {
      const w = await partialPlanWorld(`early-approval-${kind}`);
      const exit = await w.x.approvedApplication(kind, LAST, TODAY, {
        dutyTransferTiming: 'approval_passed',
        dutyTransfer: w.plan,
      });
      expect(await w.x.headAt(w.org.id, TODAY)).toBe(w.receiver.id);
      expect(await w.x.managerOf(w.subordinate.id, TODAY)).toBe(w.x.employee.id);
      await expectLanded(w, exit.id, kind, TODAY);
    });
  },
);

describe('P2-1 指定日期到日已提前转交部分职责', () => {
  it('定时任务先转交组织负责人；落地时计划外下属 S 上级被清空，无锁错误', async () => {
    const w = await partialPlanWorld('early-due');
    const exit = await w.x.approvedApplication('leave', LAST, TODAY, {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: DUE,
      dutyTransfer: w.plan,
    });
    expect(await w.x.runScheduler(`${DUE}T02:00:00Z`)).toMatchObject({ errors: [] });
    expect(await w.x.headAt(w.org.id, DUE)).toBe(w.receiver.id);
    expect(await w.x.managerOf(w.subordinate.id, DUE)).toBe(w.x.employee.id);
    await expectLanded(w, exit.id, 'leave', DUE);
  });
});

describe('P2-1 业务生效时转交', () => {
  it('落地时先按计划转交组织负责人，再清空计划外下属 S 的上级', async () => {
    const w = await partialPlanWorld('early-effective');
    const exit = await w.x.approvedApplication('leave', LAST, TODAY, {
      dutyTransferTiming: 'business_effective',
      dutyTransfer: w.plan,
    });
    expect(await w.x.headAt(w.org.id, TODAY)).toBe(w.x.employee.id);
    await expectLanded(w, exit.id, 'leave', EFFECTIVE);
  });
});

describe('P2-1 虚线下属同样纳入清空预锁', () => {
  it('审批通过时已转交组织负责人；计划外的虚线下属落地时虚线上级被清空', async () => {
    const w = await partialPlanWorld('early-dotted');
    const dotted = await w.x.session.employee('合成虚线下属');
    await w.x.session.business(
      dotted.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: w.x.from.id, dottedManagerId: w.x.employee.id },
      },
      dotted.revision,
    );
    const exit = await w.x.approvedApplication('leave', LAST, TODAY, {
      dutyTransferTiming: 'approval_passed',
      dutyTransfer: w.plan,
    });
    expect(await w.x.activate(exit.id, EFFECTIVE)).toMatchObject({ outcome: 'effective' });
    expect(await w.x.managerOf(w.subordinate.id, EFFECTIVE)).toBeNull();
    const cleared = await w.x.sqlRows<{ subordinate: string; relation: string; code: string | null }>(sql`
      SELECT subordinate_id::text AS subordinate, relation, failure_code AS code FROM duty_transfer_records
      WHERE tenant_id=${w.x.tenantId} AND employee_id=${w.x.employee.id}::uuid AND duty_type=2
        AND subordinate_id IN (${w.subordinate.id}::uuid, ${dotted.id}::uuid)
      ORDER BY relation`);
    expect(cleared).toEqual([
      { subordinate: w.subordinate.id, relation: 'direct', code: null },
      { subordinate: dotted.id, relation: 'dotted', code: null },
    ]);
  });
});
