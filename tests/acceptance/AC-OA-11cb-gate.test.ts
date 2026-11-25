/**
 * BE-11c-b 开闸（R2-T08 §7 / §8.3；生产发现 → 运行器默认执行器）：用可信夹具写入的调动明细，走真实审批通过 →
 * 默认排期 → 默认运行器，不注入调动执行器。
 * AC-OA-17（调动部分）未来生效日执行后“已执行 / 成功”、当天读不到、生效日读回；
 * AC-OA-37（员工层）执行时复核申请人的员工范围；
 * AC-OA-35（人员部分）同单新建组织 A 与转入 A 的人员，A 失败则人员行 DEPENDENCY_FAILED；
 * 以及对应保护：调动明细对外入口的既有关闭项。
 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferWorld } from './AC-OA-11cb-support.js';
import { newOrg, rename } from './AC-OA-items-support.js';
import { only } from './AC-OA-head-support.js';

const testDb = useTestDb();
const TODAY = '2026-10-01';

describe('AC-OA-17 未来生效（调动部分）', () => {
  it('默认排期计入调动明细，默认运行器执行：已执行 / 成功，当天仍在原部门，生效日读回目标部门', async () => {
    const w = await transferWorld(testDb().db, 'oa17-transfer');
    const mover = await w.staff(w.a);
    const target = await w.org('ZZ_未来改名', w.a);
    const adjustment = await w.approvedWithTransfers([w.a, w.b], [[mover]], [rename(target, { name: 'ZZ_未来新名' })]);

    await w.run();

    const head = await w.headRow(adjustment.id);
    expect(head, '调动明细必须计入数据量并随单据一起执行').toMatchObject({
      approval_status: 2,
      execution_status: 2,
      data_volume: 2,
      success_count: 2,
      failure_count: 0,
    });
    const [row] = await w.transferRows(adjustment.id);
    expect(row).toMatchObject({ exec_phase: 2, execution_result: 1 });
    expect(row!.created_business_id).toEqual(expect.any(String));
    expect((await w.currentRecord(mover, TODAY))!.department_id).toBe(w.a);
    expect(await w.currentRecord(mover)).toMatchObject({
      department_id: w.b,
      kind: 'transfer',
      change_type: 'org_adjustment',
    });
  });
});

describe('AC-OA-37 员工层', () => {
  it('申请人已无权该员工 → 该调动组 APPLICANT_OUT_OF_SCOPE、人员不变；范围内的组照常', async () => {
    const w = await transferWorld(testDb().db, 'oa37-transfer');
    const [kept, lost] = [await w.staff(w.a), await w.staff(w.b)];
    const adjustment = await w.approvedWithTransfers([w.a, w.b], [[kept], [lost, { departmentId: w.a }]]);
    w.scopes.employment = only(w.a); // 审批后收窄：只剩 A 下的员工，B 下的 lost 不再可见

    await w.run();

    const rows = await w.transferRows(adjustment.id);
    expect(rows.map((row) => [row.employee_id, row.execution_result, row.execution_reason])).toEqual([
      [kept, 1, null],
      [lost, 2, 'APPLICANT_OUT_OF_SCOPE'],
    ]);
    expect((await w.currentRecord(lost))!.department_id).toBe(w.b);
    expect((await w.currentRecord(kept))!.department_id).toBe(w.b);
  });
});

describe('AC-OA-35 人员部分', () => {
  it('同单新建组织 A 并把人员转入 A：A 先落地，人员行引用正式 ID', async () => {
    const w = await transferWorld(testDb().db, 'oa35-transfer');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));
    const created = await w.item(view.id, newOrg(w.a, { name: 'ZZ_同单新组织' }));
    const orgItemId = created.items[0]!.id;
    await w.seed(view.id, mover, { departmentId: null, departmentItemId: orgItemId });
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');

    await w.run();

    const [org] = [...(await w.outcomes(view.id)).values()];
    const [row] = await w.transferRows(view.id);
    expect(org).toMatchObject({ execution_result: 1 });
    expect(row).toMatchObject({ exec_phase: 2, execution_result: 1 });
    expect((await w.currentRecord(mover))!.department_id).toBe(org!.created_org_id);
  });

  it('A 执行失败：人员行 DEPENDENCY_FAILED，不写任职', async () => {
    const w = await transferWorld(testDb().db, 'oa35-dependency');
    const mover = await w.staff(w.a);
    const view = await w.created(w.headBody({ adjustmentRange: [w.a] }));
    const created = await w.item(view.id, newOrg(w.a, { name: 'ZZ_同单必败组织' }));
    await w.seed(view.id, mover, { departmentId: null, departmentItemId: created.items[0]!.id });
    await w.submitted(view.id);
    await w.acted(view.id, w.hrbp, 'approve');
    await w.acted(view.id, w.head, 'approve');
    // 申请人组织层范围收窄到只剩另一个组织：新建 A 的上级不再在范围内 → A 失败
    w.access.org = only(w.b);

    await w.run();

    const [org] = [...(await w.outcomes(view.id)).values()];
    const [row] = await w.transferRows(view.id);
    expect(org).toMatchObject({ execution_result: 2 });
    expect(row).toMatchObject({
      execution_result: 2,
      execution_reason: 'DEPENDENCY_FAILED',
      created_business_id: null,
    });
    expect((await w.currentRecord(mover))!.department_id).toBe(w.a);
  });
});
