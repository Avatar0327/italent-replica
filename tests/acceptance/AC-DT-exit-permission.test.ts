/**
 * R2-T09b P2-1：转交控制项（时机 / 指定日期）在真实字段授权下的编辑链。
 * 授权器按目录规则逐字段判定（未登记字段、系统只读字段一律拒绝，与生产 fieldWriteViolations 同口径），不用 allowAll：
 * 尚未转交的离职单可改时机、已转交返回 EXIT_DUTY_TRANSFER_LOCKED；已确认的单据改成 approval_passed 仍在落地时转交。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dutyExitWorld, TODAY } from './AC-DT-exit-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, label, TODAY);
const VISIBLE = [...MODULE_OBJECTS.employmentRecord.fields, ...MODULE_OBJECTS.employee.fields].map((f) => f.code);

/** 目录忠实授权器：写字段必须已登记且非系统字段；其余（对象、按钮）放行，范围由入口另验。 */
const catalogAuthorizer: Authorizer = (request) => {
  if (request.action !== 'object.update' && request.action !== 'object.create') return true;
  const object = Object.values(MODULE_OBJECTS).find((entry) => entry.code === request.resource);
  const known = new Map((object?.fields ?? []).map((field) => [field.code, field]));
  return (request.fields ?? []).every((code) => known.has(code) && !known.get(code)!.system);
};

async function setup(label: string) {
  const x = await world(label);
  const subordinate = await x.subordinateOf(x.employee.id, '合成下属');
  const receiver = await x.peer('合成接收人');
  const plan = x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] });
  const leave = await x.createdDirect('leave', '2026-10-20', { dutyTransfer: plan });
  const call = x.restricted(catalogAuthorizer, undefined, VISIBLE);
  const patch = (revision: number, body: object) => call('PATCH', `/exits/${leave.id}`, { ifMatch: revision, body });
  return { x, subordinate, receiver, leave, patch };
}

describe('P2-1 真实字段授权下编辑转交时机', () => {
  it('尚未转交：只改时机与指定日期的编辑通过授权并生效', async () => {
    const { x, leave, patch } = await setup('perm-unlocked');
    const changed = await patch(leave.revision, {
      dutyTransferTiming: 'specified_date',
      dutyTransferDate: '2026-10-12',
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'specified_date', date: '2026-10-12' });
  });

  it('已转交：改时机返回 EXIT_DUTY_TRANSFER_LOCKED（不是授权 403），时机保持', async () => {
    const { x, leave, patch } = await setup('perm-locked');
    const first = await patch(leave.revision, { dutyTransferTiming: 'specified_date', dutyTransferDate: '2026-10-12' });
    const saved = (await first.json()) as { revision: number };
    await x.runScheduler('2026-10-12T02:00:00Z');
    expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded' });

    const locked = await patch(saved.revision, { dutyTransferTiming: 'business_effective' });
    expect(await x.problem(locked)).toMatchObject({ status: 409, reason: 'EXIT_DUTY_TRANSFER_LOCKED' });
    expect(await x.exitTiming(leave.id)).toEqual({ timing: 'specified_date', date: '2026-10-12' });
  });

  it('已确认的单据改成 approval_passed：不会因确认阶段已过而永不执行，落地时转交', async () => {
    const { x, subordinate, receiver, leave, patch } = await setup('perm-approval-passed');
    const changed = await patch(leave.revision, { dutyTransferTiming: 'approval_passed' });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await x.items(leave.id)).toEqual([]);

    expect(await x.activate(leave.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect(await x.managerOf(subordinate.id, '2026-10-21')).toBe(receiver.id);
    expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded', effective: '2026-10-21' });
  });
});
