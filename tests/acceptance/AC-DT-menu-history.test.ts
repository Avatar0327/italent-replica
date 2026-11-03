/**
 * R2-T09a 职责转交菜单：下属转交生成任职记录的版本链边界（F-448，第 2 轮交叉审 P3-1；`30` DT-R7 / AC-DT-04）。
 * 菜单口径经公共写入 createEmploymentBusiness 插入“数据调整”记录；这里钉住菜单路径本身在四种情况下的结果：
 * - 其后已有未来记录：按 `07` A7 向后更新上级字段，未来记录仍排在后面；
 * - 转交日当天已有别的业务：数据调整排在当日最后（DEC-108），当日现行记录取它；
 * - 同一下属的直线、虚线都挂在被转交人名下：同一批产生两条数据调整，最终两种上级各归各的接收人；
 * - 同批某条造成汇报线循环：整批拒绝，同批合法条目也不写记录、不改上级。
 */
import './support/exit-gate-enforced.js';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { findCurrentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import { MENU_TODAY, menuWorld, subordinateItem, type MenuWorld } from './AC-DT-menu-support.js';

const database = useTestDb();
const world = (label: string) => menuWorld(database().db, label);
const LATER = '2026-10-20';
const FUTURE = '2026-11-01';

/** at 日现行任职的直线 / 虚线经理（读任职读模型）。 */
const managersOf = (x: MenuWorld, employeeId: string, at: string) =>
  withTenant(database().db, x.session.tenant.id, async (tx) => {
    const fields = (await findCurrentRecord(tx, x.session.tenant.id, employeeId, at))?.fields;
    return { direct: fields?.directManagerId ?? null, dotted: fields?.dottedManagerId ?? null };
  });

/** 给员工追加一条直接办理的业务（转正），生效日 effectiveDate。 */
async function regularize(x: MenuWorld, employeeId: string, effectiveDate: string) {
  const employee = await x.session.getEmployee(employeeId);
  await x.session.business(employeeId, { kind: 'regularization', mode: 'direct', effectiveDate }, employee.revision);
}

describe('DT-R7 / AC-DT-04 菜单下属转交的版本链边界（F-448，第 2 轮 P3-1）', () => {
  it('其后已有未来记录：立即转交插在中间，未来记录的直线经理按 A7 向后更新为接收人', async () => {
    const x = await world('history-forward');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await regularize(x, subordinate.id, FUTURE);
    const before = await x.segments(subordinate.id);
    expect(before.at(-1)).toMatchObject({ start: FUTURE, kind: 'regularization' });
    expect(await x.managerOf(subordinate.id, FUTURE)).toBe(x.employee.id);

    await x.submitted(x.employee.id, { timing: 'immediate', items: [subordinateItem(subordinate.id, receiver.id)] });

    const after = await x.segments(subordinate.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(-2)).toEqual([
      { start: MENU_TODAY, kind: 'org_adjustment', changeType: 'data_adjustment' },
      before.at(-1),
    ]);
    expect(await x.managerOf(subordinate.id, '2026-10-05')).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, MENU_TODAY)).toBe(receiver.id);
    expect(await x.managerOf(subordinate.id, FUTURE)).toBe(receiver.id);
  });

  it('到期执行同样向后更新：转交日期之后的未来记录改为接收人，转交日期前不变', async () => {
    const x = await world('history-forward-due');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await regularize(x, subordinate.id, FUTURE);
    const before = await x.segments(subordinate.id);
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });

    await x.runScheduler(`${LATER}T02:00:00Z`);
    const after = await x.segments(subordinate.id);
    expect(after.slice(-2)).toEqual([
      { start: LATER, kind: 'org_adjustment', changeType: 'data_adjustment' },
      before.at(-1),
    ]);
    expect(await x.managerOf(subordinate.id, '2026-10-19')).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, FUTURE)).toBe(receiver.id);
  });

  it('转交日当天已有别的业务：数据调整排在当日最后（DEC-108），当日现行记录取它', async () => {
    const x = await world('history-same-day');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await regularize(x, subordinate.id, MENU_TODAY);
    const before = await x.segments(subordinate.id);
    expect(before.at(-1)).toMatchObject({ start: MENU_TODAY, kind: 'regularization' });

    await x.submitted(x.employee.id, { timing: 'immediate', items: [subordinateItem(subordinate.id, receiver.id)] });

    const after = await x.segments(subordinate.id);
    expect(after).toEqual([...before, { start: MENU_TODAY, kind: 'org_adjustment', changeType: 'data_adjustment' }]);
    expect(await x.managerOf(subordinate.id, MENU_TODAY)).toBe(receiver.id);
  });

  it('直线、虚线都挂在被转交人名下：同一批两条数据调整，直线 / 虚线各归各的接收人', async () => {
    const x = await world('history-both');
    const subordinate = await x.session.employee('双线下属');
    await x.session.business(
      subordinate.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-09-01',
        fields: { departmentId: x.from.id, directManagerId: x.employee.id, dottedManagerId: x.employee.id },
      },
      subordinate.revision,
    );
    const directReceiver = await x.peer('直线接收人');
    const dottedReceiver = await x.peer('虚线接收人');
    const before = await x.segments(subordinate.id);

    const result = await x.submitted(x.employee.id, {
      timing: 'immediate',
      items: [
        subordinateItem(subordinate.id, directReceiver.id),
        { ...subordinateItem(subordinate.id, dottedReceiver.id), relation: 'dotted' },
      ],
    });

    expect(result.count).toBe(2);
    const adjustment = { start: MENU_TODAY, kind: 'org_adjustment', changeType: 'data_adjustment' };
    expect(await x.segments(subordinate.id)).toEqual([...before, adjustment, adjustment]);
    expect(await managersOf(x, subordinate.id, MENU_TODAY)).toEqual({
      direct: directReceiver.id,
      dotted: dottedReceiver.id,
    });
    expect(await managersOf(x, subordinate.id, '2026-10-05')).toEqual({ direct: x.employee.id, dotted: x.employee.id });
  });

  it('同批一条造成汇报线循环：整批 400，同批合法条目也不写任职记录、不改上级、不留转交记录', async () => {
    const x = await world('history-cycle');
    const fine = await x.subordinateOf(x.employee.id, '合法下属');
    const looped = await x.subordinateOf(x.employee.id, '循环下属');
    const grandchild = await x.subordinateOf(looped.id, '循环下属的下属');
    const receiver = await x.peer('接收人');
    const fineBefore = await x.segments(fine.id);
    const loopedBefore = await x.segments(looped.id);

    const response = await x.submit(x.employee.id, {
      timing: 'immediate',
      items: [subordinateItem(fine.id, receiver.id), subordinateItem(looped.id, grandchild.id)],
    });

    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'REPORTING_CYCLE' });
    expect(await x.segments(fine.id)).toEqual(fineBefore);
    expect(await x.segments(looped.id)).toEqual(loopedBefore);
    expect(await x.managerOf(fine.id)).toBe(x.employee.id);
    expect(await x.managerOf(looped.id)).toBe(x.employee.id);
    expect((await x.records()).total).toBe(0);
  });
});
