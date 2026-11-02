/**
 * R2-T09a 职责转交菜单：立即转交 / 指定日期 / 到期执行 / 待生效期间改日期、改接收人、改立即、清空撤回，
 * DT-R6 接收人提示与汇报线循环（DEC-602② / DEC-726 / F-408；规格 `30` §补充“菜单立即转交实测”“菜单指定日期转交实测”）。
 * F-408④（到期由定时任务执行、写转交时间、组织新版本启用日 = 转交日期）未实测，按派单口径断言，合并前核对。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { headItem, MENU_TODAY, menuWorld, subordinateItem } from './AC-DT-menu-support.js';

const database = useTestDb();
const world = (label: string) => menuWorld(database().db, label);
const LATER = '2026-10-20';

describe('立即生效（DEC-726，W-607）', () => {
  it('组织负责人：生成组织新版本、启用日 = 当天，记录已完成并写转交时间', async () => {
    const x = await world('now-org');
    await x.setHead(x.from.id, x.employee.id);
    const receiver = await x.peer('接收人');

    const before = await x.duties(x.employee.id);
    const head = before.items.find((item) => item.dutyType === 1 && item.orgId === x.from.id);
    expect(head).toMatchObject({ orgRole: 'person_in_charge', pending: null });

    const confirm = await x.check(x.employee.id, { timing: 'immediate', items: [headItem(x.from.id, receiver.id)] });
    expect(confirm).toMatchObject({ count: 1, receivers: [{ receiverId: receiver.id, count: 1 }], warnings: [] });
    expect(confirm.message).toBe('请确认以下信息：1个 职责将转交给 接收人');

    const result = await x.submitted(x.employee.id, { timing: 'immediate', items: [headItem(x.from.id, receiver.id)] });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      employeeId: x.employee.id,
      receiverId: receiver.id,
      dutyType: 1,
      status: 1,
      source: 1,
      transferDate: MENU_TODAY,
      operatorId: x.session.user.id,
    });
    expect(result.records[0]!.transferTime).not.toBeNull();

    expect((await x.orgVersions(x.from.id)).at(-1)).toEqual({ start: MENU_TODAY, head: receiver.id });
    expect(await x.headAt(x.from.id, '2026-10-05')).toBe(x.employee.id);
    const after = await x.duties(x.employee.id);
    expect(after.items.some((item) => item.dutyType === 1 && item.orgId === x.from.id)).toBe(false);
    expect((await x.records('tab=completed')).items.map((row) => row.id)).toContain(result.records[0]!.id);
  });

  it('直线下属：下属的直线经理改为接收人', async () => {
    const x = await world('now-sub');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');

    const result = await x.submitted(x.employee.id, {
      timing: 'immediate',
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    expect(result.records[0]).toMatchObject({ dutyType: 2, status: 1 });
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
  });
});

describe('指定日期（F-408）', () => {
  it('到期前：未完成、转交时间空、职责不动、接收人不持有、出现在待生效页签，被转交人看到生效提示', async () => {
    const x = await world('scheduled');
    await x.setHead(x.from.id, x.employee.id);
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');

    const result = await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [headItem(x.from.id, receiver.id), subordinateItem(subordinate.id, receiver.id)],
    });
    expect(result.records.map((row) => [row.status, row.transferTime, row.transferDate])).toEqual([
      [0, null, LATER],
      [0, null, LATER],
    ]);

    expect(await x.headAt(x.from.id, MENU_TODAY)).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
    const mine = await x.duties(x.employee.id);
    expect(mine.items.map((item) => item.pending?.receiverId)).toEqual([receiver.id, receiver.id]);
    expect(mine.items.map((item) => item.pending?.transferDate)).toEqual([LATER, LATER]);
    expect(mine).toMatchObject({ total: 2, pendingCount: 2 });
    expect(mine.hint).toBe(`2 个职责已全部设置接收人，将于 ${LATER} 生效`);
    expect((await x.duties(receiver.id)).items).toEqual([]);

    const pending = await x.records('tab=pending');
    expect(pending.items.map((row) => row.id).sort()).toEqual(result.records.map((row) => row.id).sort());
    expect((await x.records('tab=completed')).items).toEqual([]);
  });

  it('不得早于明天：转交日期 = 今天报错', async () => {
    const x = await world('scheduled-today');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    const response = await x.submit(x.employee.id, {
      timing: 'scheduled',
      transferDate: MENU_TODAY,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'DUTY_TRANSFER_DATE_NOT_FUTURE' });
  });

  it('到期执行：定时任务落地，记录已完成、写转交时间，组织新版本启用日 = 转交日期；重跑不重复', async () => {
    const x = await world('due');
    await x.setHead(x.from.id, x.employee.id);
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [headItem(x.from.id, receiver.id), subordinateItem(subordinate.id, receiver.id)],
    });

    await x.runScheduler('2026-10-19T02:00:00Z');
    expect((await x.records('tab=pending')).total).toBe(2);
    expect(await x.headAt(x.from.id, LATER)).toBe(x.employee.id);

    await x.runScheduler(`${LATER}T02:00:00Z`);
    const done = await x.records('tab=completed');
    expect(done.items.map((row) => [row.status, row.transferDate])).toEqual([
      [1, LATER],
      [1, LATER],
    ]);
    expect(done.items.every((row) => row.transferTime !== null)).toBe(true);
    expect((await x.records('tab=pending')).total).toBe(0);
    expect((await x.orgVersions(x.from.id)).at(-1)).toEqual({ start: LATER, head: receiver.id });
    expect(await x.managerOf(subordinate.id, LATER)).toBe(receiver.id);

    const versions = (await x.orgVersions(x.from.id)).length;
    await x.runScheduler(`${LATER}T03:00:00Z`);
    expect((await x.orgVersions(x.from.id)).length).toBe(versions);
    expect((await x.records('tab=completed')).total).toBe(2);
  });
});

describe('待生效期间再次选同一被转交人（DEC-726，唯一入口）', () => {
  it('改日期 + 改接收人覆盖原记录（同一职责至多一条待生效），清空接收人即撤回，到期不执行', async () => {
    const x = await world('edit');
    await x.setHead(x.from.id, x.employee.id);
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const [first, second] = [await x.peer('原接收人'), await x.peer('新接收人')];
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [headItem(x.from.id, first.id), subordinateItem(subordinate.id, first.id)],
    });

    const filled = await x.duties(x.employee.id);
    const [org, sub] = [filled.items[0]!.pending!, filled.items[1]!.pending!];
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: '2026-10-15',
      items: [headItem(x.from.id, second.id, org.revision), subordinateItem(subordinate.id, null, sub.revision)],
    });

    const pending = await x.records('tab=pending');
    expect(pending.items.map((row) => [row.dutyType, row.receiverId, row.transferDate])).toEqual([
      [1, second.id, '2026-10-15'],
    ]);
    const all = await x.records('tab=all');
    expect(all.items.filter((row) => row.status === 2).map((row) => row.dutyType)).toEqual([2]);

    await x.runScheduler(`${LATER}T02:00:00Z`);
    expect(await x.headAt(x.from.id, '2026-10-15')).toBe(second.id);
    expect(await x.managerOf(subordinate.id, LATER)).toBe(x.employee.id);
  });

  it('改为立即生效：待生效记录当天执行并转为已完成，不再留待生效', async () => {
    const x = await world('to-now');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    const { revision } = (await x.duties(x.employee.id)).items[0]!.pending!;

    await x.submitted(x.employee.id, {
      timing: 'immediate',
      items: [subordinateItem(subordinate.id, receiver.id, revision)],
    });
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect((await x.records('tab=pending')).total).toBe(0);
    expect((await x.records('tab=completed')).items.map((row) => row.transferDate)).toEqual([MENU_TODAY]);
  });

  it('旧版本号再次提交：409，不覆盖', async () => {
    const x = await world('stale');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    const response = await x.submit(x.employee.id, {
      timing: 'scheduled',
      transferDate: '2026-10-15',
      items: [subordinateItem(subordinate.id, receiver.id, 99)],
    });
    expect((await x.reason(response)).status).toBe(409);
    expect((await x.records('tab=pending')).items.map((row) => row.transferDate)).toEqual([LATER]);
  });
});

describe('DT-R6（DEC-726）', () => {
  it('接收人已离职：确认信息给出提示，立即转交被拒且职责不动', async () => {
    const x = await world('receiver-left');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('已离职接收人');
    await x.effectiveExit(receiver.id);
    const body = { timing: 'immediate' as const, items: [subordinateItem(subordinate.id, receiver.id)] };

    expect((await x.check(x.employee.id, body)).warnings).toEqual([
      { receiverId: receiver.id, reason: 'RECEIVER_NOT_ACTIVE' },
    ]);
    const response = await x.submit(x.employee.id, body);
    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
    expect((await x.records('tab=all')).total).toBe(0);
  });

  it('下属转交造成汇报线循环：报错，直线经理不变', async () => {
    const x = await world('cycle');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const grandchild = await x.subordinateOf(subordinate.id, '下属的下属');
    const response = await x.submit(x.employee.id, {
      timing: 'immediate',
      items: [subordinateItem(subordinate.id, grandchild.id)],
    });
    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'REPORTING_CYCLE' });
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
  });
});

describe('DT-R7 / AC-DT-04：菜单转交下属生成任职记录（第 2 轮 P2-1）', () => {
  it('立即：自转交日起插入“数据调整”记录，转交日前仍是原经理', async () => {
    const x = await world('history-now');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    const before = await x.segments(subordinate.id);

    await x.submitted(x.employee.id, { timing: 'immediate', items: [subordinateItem(subordinate.id, receiver.id)] });

    const after = await x.segments(subordinate.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toEqual({ start: MENU_TODAY, kind: 'org_adjustment', changeType: 'data_adjustment' });
    expect(await x.managerOf(subordinate.id, '2026-09-15')).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, '2026-10-05')).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, MENU_TODAY)).toBe(receiver.id);
  });

  it('到期：自转交日期起插入“数据调整”记录，到期前一天仍是原经理', async () => {
    const x = await world('history-due');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    const before = await x.segments(subordinate.id);
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    expect(await x.segments(subordinate.id)).toEqual(before);

    await x.runScheduler(`${LATER}T02:00:00Z`);
    const after = await x.segments(subordinate.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toEqual({ start: LATER, kind: 'org_adjustment', changeType: 'data_adjustment' });
    expect(await x.managerOf(subordinate.id, '2026-10-19')).toBe(x.employee.id);
    expect(await x.managerOf(subordinate.id, LATER)).toBe(receiver.id);
    expect((await x.records('tab=completed')).total).toBe(1);
  });
});

describe('接收人为空即不转交（DEC-726，第 2 轮 P2-2）', () => {
  async function twoSubordinates(label: string) {
    const x = await world(label);
    const one = await x.subordinateOf(x.employee.id, '下属甲');
    const two = await x.subordinateOf(x.employee.id, '下属乙');
    const receiver = await x.peer('接收人');
    return { x, one, two, receiver };
  }

  it('立即 · 部分设置：设置了接收人的转交，空的跳过；确认数量与持久化条数一致', async () => {
    const { x, one, two, receiver } = await twoSubordinates('blank-now');
    const body = {
      timing: 'immediate' as const,
      items: [subordinateItem(one.id, receiver.id), subordinateItem(two.id, null)],
    };
    expect((await x.check(x.employee.id, body)).count).toBe(1);
    const result = await x.submitted(x.employee.id, body);
    expect(result.count).toBe(1);
    expect(result.records.map((row) => [row.receiverId, row.status])).toEqual([[receiver.id, 1]]);
    expect(await x.managerOf(one.id)).toBe(receiver.id);
    expect(await x.managerOf(two.id)).toBe(x.employee.id);
    expect((await x.records()).total).toBe(1);
  });

  it('指定日期 · 部分设置：只为设置了接收人的职责记待生效', async () => {
    const { x, one, two, receiver } = await twoSubordinates('blank-later');
    const result = await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(one.id, null), subordinateItem(two.id, receiver.id)],
    });
    expect(result.count).toBe(1);
    expect((await x.records('tab=pending')).items.map((row) => row.receiverId)).toEqual([receiver.id]);
    const menu = await x.duties(x.employee.id);
    expect(menu.pendingCount).toBe(1);
    expect(menu.items.find((item) => item.subordinateId === one.id)?.pending).toBeNull();
  });

  it('全空且无待生效记录：400，不写记录', async () => {
    const { x, one, two } = await twoSubordinates('blank-all');
    for (const timing of ['immediate', 'scheduled'] as const) {
      const response = await x.submit(x.employee.id, {
        timing,
        ...(timing === 'scheduled' ? { transferDate: LATER } : {}),
        items: [subordinateItem(one.id, null), subordinateItem(two.id, null)],
      });
      expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'DUTY_TRANSFER_EMPTY' });
    }
    expect((await x.records()).total).toBe(0);
    expect(await x.managerOf(one.id)).toBe(x.employee.id);
  });

  it('预览与提交“全部为空”同口径（F-448，第 2 轮交叉审 P3-5）：全空且无待生效记录时预览也 400', async () => {
    const { x, one, two, receiver } = await twoSubordinates('blank-check');
    for (const timing of ['immediate', 'scheduled'] as const) {
      const response = await x.request('POST', `/people/${x.employee.id}/check`, {
        body: {
          timing,
          ...(timing === 'scheduled' ? { transferDate: LATER } : {}),
          items: [subordinateItem(one.id, null), subordinateItem(two.id, null)],
        },
      });
      expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'DUTY_TRANSFER_EMPTY' });
    }

    // 空接收人但有待生效记录：提交会撤回该记录（不报全空），预览同样放行。
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(one.id, receiver.id)],
    });
    const revision = (await x.duties(x.employee.id)).items.find((item) => item.subordinateId === one.id)!.pending!
      .revision;
    const withdraw = await x.check(x.employee.id, {
      timing: 'immediate',
      items: [subordinateItem(one.id, null, revision), subordinateItem(two.id, null)],
    });
    expect(withdraw).toMatchObject({ count: 0, receivers: [] });
  });

  it('已有待生效记录的空接收人带 revision 撤回，同批无记录的空接收人跳过、其余立即转交', async () => {
    const { x, one, two, receiver } = await twoSubordinates('blank-void');
    const third = await x.subordinateOf(x.employee.id, '下属丙');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(one.id, receiver.id)],
    });
    const revision = (await x.duties(x.employee.id)).items.find((item) => item.subordinateId === one.id)!.pending!
      .revision;

    const result = await x.submitted(x.employee.id, {
      timing: 'immediate',
      items: [
        subordinateItem(one.id, null, revision),
        subordinateItem(two.id, null),
        subordinateItem(third.id, receiver.id),
      ],
    });
    expect(result.count).toBe(2);
    expect(result.records.map((row) => row.status).sort()).toEqual([1, 2]);
    expect((await x.records('tab=pending')).total).toBe(0);
    expect((await x.records()).total).toBe(2);
    expect(await x.managerOf(one.id)).toBe(x.employee.id);
    expect(await x.managerOf(two.id)).toBe(x.employee.id);
    expect(await x.managerOf(third.id)).toBe(receiver.id);

    await x.runScheduler(`${LATER}T02:00:00Z`);
    expect(await x.managerOf(one.id, LATER)).toBe(x.employee.id);
  });
});

describe('转交日期须是合法日历日（DEC-726，第 2 轮 P2-5）', () => {
  it('不存在的日期 400，职责、记录、命令台账都不变；闰日与合法未来日期可提交；今天 / 过去 400', async () => {
    const x = await world('calendar');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    const body = (transferDate: string) => ({
      timing: 'scheduled' as const,
      transferDate,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });

    for (const day of ['2026-11-31', '2027-02-29']) {
      const check = await x.request('POST', `/people/${x.employee.id}/check`, { body: body(day) });
      expect(await x.reason(check)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      const response = await x.submit(x.employee.id, body(day), `calendar-${day}`);
      expect(await x.reason(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
    expect((await x.records()).total).toBe(0);
    expect((await x.duties(x.employee.id)).pendingCount).toBe(0);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);

    for (const day of [MENU_TODAY, '2026-10-01'])
      expect(await x.reason(await x.submit(x.employee.id, body(day)))).toMatchObject({
        status: 400,
        reason: 'DUTY_TRANSFER_DATE_NOT_FUTURE',
      });

    // 同一命令 ID 改成合法日期重提：失败的请求没有进入命令台账，不报同键异内容。
    const leap = await x.submit(x.employee.id, body('2028-02-29'), 'calendar-2026-11-31');
    expect(leap.status, await leap.clone().text()).toBe(200);
    expect((await x.records('tab=pending')).items.map((row) => row.transferDate)).toEqual(['2028-02-29']);
  });
});
