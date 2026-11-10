/**
 * R2-T09a 转交记录三页签与筛选、DT-R9 权限裁剪、检查离职退休人员，以及离职内转交改走共享子项执行函数后的回归
 * （DEC-602② / DEC-726 / DEC-431①；规格 `30` §补充“职责转交记录结构”“菜单界面”）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { headItem, MENU_TODAY, menuWorld, subordinateItem, type RecordView } from './AC-DT-menu-support.js';

const database = useTestDb();
const LATER = '2026-10-20';

const people = (items: readonly RecordView[]) => items.map((row) => row.employeeId);

describe('转交记录（DEC-726 三页签）', () => {
  it('全部 / 待生效 / 已完成三页签与被转交人、状态、来源筛选；全部页签含离职内转交（来源 = 离职）', async () => {
    const x = await menuWorld(database().db, 'tabs');
    await x.setHead(x.from.id, x.employee.id);
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const other = await x.peer('另一被转交人');
    const otherSub = await x.subordinateOf(other.id, '另一下属');
    const receiver = await x.peer('接收人');
    await x.submitted(x.employee.id, { timing: 'immediate', items: [headItem(x.from.id, receiver.id)] });
    await x.submitted(other.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(otherSub.id, receiver.id)],
    });

    // DT-R4：负责人已经由上面的立即转交在今天换手，保存日（今天）起不再持有；最后工作日取今天，生效日次日
    const leave = await x.directLeave(
      MENU_TODAY,
      x.dutyPlan([{ employeeId: subordinate.id, receiverId: receiver.id }]),
    );
    await x.activate(leave.id, '2026-10-07');
    expect(await x.managerOf(subordinate.id, '2026-10-07')).toBe(receiver.id);

    const all = await x.records('tab=all');
    expect(all.total).toBe(3);
    expect(all.items.map((row) => [row.source, row.status]).sort()).toEqual([
      [1, 0],
      [1, 1],
      [2, 1],
    ]);
    const exit = all.items.find((row) => row.source === 2)!;
    expect(exit).toMatchObject({ employeeId: x.employee.id, receiverId: receiver.id, dutyType: 2, batchId: leave.id });

    const pending = await x.records('tab=pending');
    expect(people(pending.items)).toEqual([other.id]);
    expect(pending.items[0]).toMatchObject({ transferDate: LATER, transferTime: null, operatorId: x.session.user.id });

    expect((await x.records('tab=completed')).total).toBe(2);
    expect((await x.records(`tab=all&employeeId=${other.id}`)).total).toBe(1);
    expect((await x.records('tab=all&status=1')).total).toBe(2);
    expect((await x.records('tab=all&source=2')).items.map((row) => row.batchId)).toEqual([leave.id]);
    expect((await x.records('tab=completed&source=1')).total).toBe(1);
  });

  it('DT-R9：只能看到权限范围内被转交人的记录；范围外的人菜单返回 404', async () => {
    const x = await menuWorld(database().db, 'scope');
    const visible = await x.peer('范围内');
    const hidden = await x.peer('范围外');
    const [visibleSub, hiddenSub] = [
      await x.subordinateOf(visible.id, '范围内下属'),
      await x.subordinateOf(hidden.id, '范围外下属'),
    ];
    const receiver = await x.peer('接收人');
    for (const [person, sub] of [
      [visible, visibleSub],
      [hidden, hiddenSub],
    ] as const) {
      await x.submitted(person.id, {
        timing: 'scheduled',
        transferDate: LATER,
        items: [subordinateItem(sub.id, receiver.id)],
      });
    }

    const scoped = x.scopedRequest([visible.id]);
    const listed = await scoped('GET', '/records?tab=all');
    expect(listed.status).toBe(200);
    expect(people(((await listed.json()) as { items: RecordView[] }).items)).toEqual([visible.id]);
    expect((await scoped('GET', `/people/${hidden.id}/duties`)).status).toBe(404);
    const blocked = await scoped('POST', `/people/${hidden.id}`, {
      ifMatch: 0,
      body: { timing: 'immediate', items: [subordinateItem(hiddenSub.id, receiver.id)] },
    });
    expect(blocked.status).toBe(404);
    expect(await x.managerOf(hiddenSub.id)).toBe(hidden.id);
  });
});

describe('字段权限（DT-R9，DEC-726）', () => {
  it('看不到接收人 / 转交日期字段时：菜单回填与转交记录都不带出，生效提示（含日期）也不给', async () => {
    const x = await menuWorld(database().db, 'fields');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.submitted(x.employee.id, {
      timing: 'scheduled',
      transferDate: LATER,
      items: [subordinateItem(subordinate.id, receiver.id)],
    });
    expect((await x.duties(x.employee.id)).hint).toContain(LATER);

    const scoped = x.scopedRequest([x.employee.id], ['receiverId', 'transferDate']);
    const menu = await scoped('GET', `/people/${x.employee.id}/duties`);
    expect(menu.status).toBe(200);
    const filled = (await menu.json()) as { hint: string | null; items: { pending: Record<string, unknown> | null }[] };
    expect(filled.hint).toBeNull();
    expect(filled.items[0]!.pending).not.toBeNull();
    expect(Object.keys(filled.items[0]!.pending!).sort()).toEqual(['recordId', 'revision']);
    const listed = await scoped('GET', '/records?tab=pending');
    const [row] = ((await listed.json()) as { items: Record<string, unknown>[] }).items;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('receiverId');
    expect(row).not.toHaveProperty('transferDate');
  });
});

describe('接收人范围（DT-R9，DEC-726）', () => {
  it('接收人须在操作人的人员范围内：范围外与不存在同一 400，确认信息不带出姓名，提交不改写', async () => {
    const x = await menuWorld(database().db, 'receiver-scope');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const outside = await x.peer('范围外接收人');
    const inside = await x.peer('范围内接收人');
    const ghost = '00000000-0000-4000-8000-0000000000aa';
    const scoped = x.scopedRequest([x.employee.id, inside.id]);
    const body = (receiverId: string) => ({
      timing: 'immediate',
      items: [subordinateItem(subordinate.id, receiverId)],
    });

    const errorOf = async (response: Response) => {
      const text = await response.text();
      expect(text).not.toContain('范围外接收人');
      const { error } = JSON.parse(text) as { error: { code: string; message: string; details?: { reason?: string } } };
      return [response.status, error.code, error.message, error.details?.reason];
    };
    const checkOutside = await errorOf(
      await scoped('POST', `/people/${x.employee.id}/check`, { body: body(outside.id) }),
    );
    expect(checkOutside[0]).toBe(400);
    expect(checkOutside[3]).toBe('TRANSFER_PERSON_NOT_ELIGIBLE');
    expect(await errorOf(await scoped('POST', `/people/${x.employee.id}/check`, { body: body(ghost) }))).toEqual(
      checkOutside,
    );
    const submitOutside = await scoped('POST', `/people/${x.employee.id}`, { ifMatch: 0, body: body(outside.id) });
    expect(await errorOf(submitOutside)).toEqual(checkOutside);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);

    const ok = await scoped('POST', `/people/${x.employee.id}/check`, { body: body(inside.id) });
    expect(ok.status).toBe(200);
    const accepted = await scoped('POST', `/people/${x.employee.id}`, { ifMatch: 0, body: body(inside.id) });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await x.managerOf(subordinate.id)).toBe(inside.id);
  });
});

describe('检查离职退休人员（DEC-726）', () => {
  it('只列最近 3 个月内离职或退休且仍承担职责的人；补转交后不再出现', async () => {
    const x = await menuWorld(database().db, 'departed', '2027-01-15');
    const recent = await x.peer('近期离职');
    const recentSub = await x.subordinateOf(recent.id, '近期离职的下属');
    const longAgo = await x.peer('早期离职');
    await x.subordinateOf(longAgo.id, '早期离职的下属');
    const empty = await x.peer('无职责离职');
    const receiver = await x.peer('接收人');
    await x.effectiveExit(recent.id, '2026-12-01');
    await x.effectiveExit(longAgo.id, '2026-09-30');
    await x.effectiveExit(empty.id, '2026-12-01');

    const listed = await x.departed();
    expect(listed.items.map((row) => [row.employeeId, row.kind, row.dutyCount])).toEqual([[recent.id, 'leave', 1]]);

    await x.submitted(recent.id, { timing: 'immediate', items: [subordinateItem(recentSub.id, receiver.id)] });
    expect(await x.managerOf(recentSub.id, '2027-01-15')).toBe(receiver.id);
    expect((await x.departed()).items).toEqual([]);
  });
});
