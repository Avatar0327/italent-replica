/**
 * R2-T09b ②④ DT-R3 业务内“指定日期”时机与退休内转交（规格 `30` DT-R3 / DT-R7，DEC-602②）。
 * 与 approval_passed / business_effective 并列：日期 ≤ 今天 → 节点通过当场转交；晚于业务生效日 → 生效时转交并把时机改为
 * business_effective；其间 → 到日由定时任务转交（组织变更起始日 = 指定日期）；已转交后不能再改时机；到期执行幂等。
 * 退休与离职共用同一时机与执行（来源 4）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dutyExitWorld, TODAY } from './AC-DT-exit-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, label, TODAY);

async function oneSubordinate(x: Awaited<ReturnType<typeof world>>) {
  const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
  const receiver = await x.peer('合成接收人');
  const plan = x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] });
  return { subordinate, receiver, plan };
}

describe('DT-R3 指定日期 ≤ 今天：当前节点通过后立即转交', () => {
  it('直接离职保存：事务内当场转交，时机保持 specified_date', async () => {
    const x = await world('timing-direct-now');
    const { subordinate, receiver, plan } = await oneSubordinate(x);
    const leave = await x.createdDirect('leave', '2026-10-20', {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: TODAY,
      dutyTransfer: plan,
    });
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded', effective: TODAY });
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'specified_date', date: TODAY });
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
  });

  it('离职申请：审批通过当天转交', async () => {
    const x = await world('timing-application-now');
    const { subordinate, receiver, plan } = await oneSubordinate(x);
    const leave = await x.approvedApplication('leave', '2026-10-20', TODAY, {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: TODAY,
      dutyTransfer: plan,
    });
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded', effective: TODAY });
  });
});

describe('DT-R3 指定日期介于今天与业务生效日之间：到日由定时任务转交', () => {
  const DUE = '2026-10-12';

  it('到日转交一次，组织变更启用日 = 指定日期；重复触发不重复；生效时不再转交', async () => {
    const x = await world('timing-due');
    const { subordinate, receiver } = await oneSubordinate(x);
    const org = await x.headedOrg('合成负责人组织');
    const both = x.plan({
      subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }],
      orgRoles: [{ orgId: org.id, receiverId: receiver.id }],
    });
    const leave = await x.createdDirect('leave', '2026-10-20', {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: DUE,
      dutyTransfer: both,
    });
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);

    expect(await x.runScheduler('2026-10-11T02:00:00Z')).toMatchObject({ errors: [] });
    expect(await x.items(leave.id)).toEqual([]);

    expect(await x.runScheduler(`${DUE}T02:00:00Z`)).toMatchObject({ errors: [] });
    expect(await x.managerOf(subordinate.id, DUE)).toBe(receiver.id);
    expect((await x.orgVersions(org.id)).at(-1)).toEqual({ start: DUE, head: receiver.id });
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
    const items = await x.items(leave.id);
    expect(items.map((item) => [item.status, item.effective])).toEqual([
      ['succeeded', DUE],
      ['succeeded', DUE],
    ]);

    await x.runScheduler(`${DUE}T05:00:00Z`);
    await x.runScheduler('2026-10-13T02:00:00Z');
    expect(await x.items(leave.id)).toEqual(items);
    expect(await x.orgVersions(org.id)).toHaveLength(3);

    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.items(leave.id)).toEqual(items);
  });
});

describe('DT-R3 指定日期晚于业务生效日：生效时转交，时机改为 business_effective', () => {
  it('创建即改时机（指定日期清空），生效时执行，item 生效日 = 业务生效日', async () => {
    const x = await world('timing-after-effective');
    const { subordinate, receiver, plan } = await oneSubordinate(x);
    const leave = await x.createdDirect('leave', '2026-10-20', {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: '2026-10-30',
      dutyTransfer: plan,
    });
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'business_effective', date: null });

    await x.runScheduler('2026-10-15T02:00:00Z');
    expect(await x.items(leave.id)).toEqual([]);

    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.managerOf(subordinate.id, '2026-10-21')).toBe(receiver.id);
    expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded', effective: '2026-10-21' });
  });
});

describe('DT-R3 校验与时机锁', () => {
  it('specified_date 必须带指定日期；非 specified_date 不能带日期', async () => {
    const x = await world('timing-validate');
    const { plan } = await oneSubordinate(x);
    const missing = await x.tryDirect('leave', '2026-10-20', {
      dutyTransferTiming: 'specified_date',
      dutyTransfer: plan,
    });
    expect(missing.status).toBe(400);
    const extra = await x.tryDirect('leave', '2026-10-20', {
      dutyTransferTiming: 'business_effective',
      dutyTransferDate: TODAY,
      dutyTransfer: plan,
    });
    expect(extra.status).toBe(400);
  });

  it('尚未转交时可改时机；已转交后改时机被拒', async () => {
    const x = await world('timing-lock');
    const { plan } = await oneSubordinate(x);
    const leave = await x.createdDirect('leave', '2026-10-20', { dutyTransfer: plan });
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'business_effective', date: null });

    const changed = await x.patchExit(leave.id, leave.revision, {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: '2026-10-12',
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const saved = (await changed.json()) as { revision: number };
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'specified_date', date: '2026-10-12' });

    await x.runScheduler('2026-10-12T02:00:00Z');
    expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded' });
    const locked = await x.patchExit(leave.id, saved.revision, { dutyTransferTiming: 'business_effective' });
    const lockedText = await locked.clone().text();
    expect(await x.problem(locked), lockedText).toMatchObject({
      status: 409,
      reason: 'EXIT_DUTY_TRANSFER_LOCKED',
    });
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'specified_date', date: '2026-10-12' });
  });
});

describe('④ 退休内转交：与离职同一时机和执行（来源 4）', () => {
  it('business_effective：生效时按计划转交，记录来源 = 4', async () => {
    const x = await world('retire-effective');
    const { subordinate, receiver, plan } = await oneSubordinate(x);
    const retire = await x.createdDirect('retirement', '2026-10-20', { dutyTransfer: plan });
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
    expect(await x.activate(retire.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.managerOf(subordinate.id, '2026-10-21')).toBe(receiver.id);
    expect(await x.exitRecords()).toEqual([
      expect.objectContaining({ source: 4, status: 1, receiverId: receiver.id, dutyType: 2 }),
    ]);
  });

  it('specified_date：到日由定时任务转交一次', async () => {
    const x = await world('retire-specified');
    const { subordinate, receiver, plan } = await oneSubordinate(x);
    const retire = await x.createdDirect('retirement', '2026-10-20', {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: '2026-10-12',
      dutyTransfer: plan,
    });
    await x.runScheduler('2026-10-12T02:00:00Z');
    await x.runScheduler('2026-10-12T05:00:00Z');
    expect(await x.managerOf(subordinate.id, '2026-10-12')).toBe(receiver.id);
    expect(await x.items(retire.id)).toHaveLength(1);
    expect(await x.exitRecords()).toEqual([expect.objectContaining({ source: 4, status: 1 })]);
  });
});

describe('P2-3 通用任职编辑改期：指定日期时机同样结算', () => {
  it('草稿离职经通用 PATCH 把生效日提前到指定日期之前：改为 business_effective，并在新生效日转交', async () => {
    const x = await world('timing-generic-reschedule');
    const { subordinate, receiver } = await oneSubordinate(x);
    const org = await x.headedOrg('合成负责人组织');
    const both = x.plan({
      subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }],
      orgRoles: [{ orgId: org.id, receiverId: receiver.id }],
    });
    const draft = await x.createdLeave(
      x.employee.id,
      x.bodyOf('leave', '2026-10-20', 'application', {
        dutyTransferTiming: 'specified_date',
        dutyTransferDate: '2026-10-12',
        dutyTransfer: both,
      }),
    );
    expect(await x.exitTiming(draft.id)).toEqual({ timing: 'specified_date', date: '2026-10-12' });

    const moved = await x.session.request('PATCH', `/businesses/${draft.id}`, {
      ifMatch: draft.revision,
      body: { lastWorkDate: '2026-10-10' },
    });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await x.exitTiming(draft.id)).toEqual({ timing: 'business_effective', date: null });

    const latest = await x.business(draft.id);
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: latest.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await x.approve(latest, `${TODAY}T02:00:00Z`);
    await x.runScheduler('2026-10-11T02:00:00Z');

    expect((await x.items(draft.id)).map((item) => [item.status, item.effective])).toEqual([
      ['succeeded', '2026-10-11'],
      ['succeeded', '2026-10-11'],
    ]);
    expect(await x.headAt(org.id, '2026-10-11')).toBe(receiver.id);
    expect((await x.orgVersions(org.id)).at(-1)).toEqual({ start: '2026-10-11', head: receiver.id });
    expect(await x.managerOf(subordinate.id, '2026-10-11')).toBe(receiver.id);
  });
});

describe('P2-4 过去的指定日期：立即执行，业务生效日仍是指定日期（DT-R7）', () => {
  it('指定 10-05，10-06 节点通过：当场转交，转交子项 / 效果台账 / 组织版本的生效日都是 10-05', async () => {
    const x = await world('timing-past-date');
    const { subordinate, receiver } = await oneSubordinate(x);
    const org = await x.headedOrg('合成负责人组织');
    const both = x.plan({
      subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }],
      orgRoles: [{ orgId: org.id, receiverId: receiver.id }],
    });
    const leave = await x.approvedApplication('leave', '2026-10-20', TODAY, {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: '2026-10-05',
      dutyTransfer: both,
    });

    const items = await x.items(leave.id);
    expect(items.map((item) => [item.status, item.effective])).toEqual([
      ['succeeded', '2026-10-05'],
      ['succeeded', '2026-10-05'],
    ]);
    const ledger = await x.sqlRows<{ day: string }>(sql`SELECT detail->>'effectiveDate' AS day FROM exit_effects
      WHERE tenant_id=${x.tenantId} AND business_id=${leave.id}::uuid AND kind='duty_transferred'`);
    expect(ledger).toEqual([{ day: '2026-10-05' }, { day: '2026-10-05' }]);
    expect((await x.orgVersions(org.id)).at(-1)).toEqual({ start: '2026-10-05', head: receiver.id });
    expect(await x.headAt(org.id, '2026-10-05')).toBe(receiver.id);
    expect(await x.managerOf(subordinate.id, '2026-10-05')).toBe(receiver.id);
  });
});
