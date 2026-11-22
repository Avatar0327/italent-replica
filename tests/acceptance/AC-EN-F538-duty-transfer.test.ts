import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql } from '@italent/db';
import type { Authorizer } from '@italent/api';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { dutyExitWorld } from './AC-DT-exit-support.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retireBody } from './AC-RT-support.js';
import { withRehire } from './AC-RT-rehire-support.js';

const database = useTestDb();
const world = (label: string) => dutyExitWorld(database().db, `ZZ_F538_${label}`);
type World = Awaited<ReturnType<typeof world>>;
const last = '2026-10-20';
const effective = '2026-10-21';

async function detail(x: World, id: string, request = x.session.request) {
  const response = await request('GET', `/retirements/${id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe('AC-EN-F538 退休编辑职责转交计划', () => {
  it('AC-EN-F538-01 编辑已保存的计划和交接人，回读新计划、revision 与审计前后值', async () => {
    const x = await world('edit');
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_下属');
    const first = await x.peer('ZZ_F538_原接收人');
    const next = await x.peer('ZZ_F538_新接收人');
    const org = await x.headedOrg('ZZ_F538_负责人组织');
    const plan = (receiverId: string) =>
      x.plan({
        subordinates: [{ employeeId: subordinate.id, receiverId }],
        orgRoles: [{ orgId: org.id, receiverId }],
      });
    const draft = await x.createdRetire(
      x.employee.id,
      retireBody(last, 'application', { dutyTransfer: plan(first.id) }),
    );
    const before = await detail(x, draft.id);

    const response = await x.patchExit(
      draft.id,
      draft.revision,
      { dutyTransfer: plan(next.id), handoverEmployeeId: next.id },
      'retirement',
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(before.dutyTransferPlan).toEqual(plan(first.id));
    const { revision } = (await response.json()) as { revision: number };
    expect(revision).toBe(draft.revision + 1);
    expect(await detail(x, draft.id)).toMatchObject({
      revision,
      dutyTransferPlan: plan(next.id),
      handoverEmployeeId: next.id,
    });
    const inFlight = await x.session.request('GET', `/retirements/employees/${x.employee.id}/in-flight`);
    expect(inFlight.status, await inFlight.clone().text()).toBe(200);
    expect(await inFlight.json()).toMatchObject({ item: { id: draft.id, dutyTransferPlan: plan(next.id) } });
    const state = await x.stateOf(x.employee.id);
    expect(state.audits).toContainEqual(
      expect.objectContaining({
        action: 'transfer.linkage.save',
        before: expect.objectContaining({ dutyTransfer: plan(first.id) }),
        after: expect.objectContaining({ dutyTransfer: plan(next.id) }),
      }),
    );
    expect(await x.audits(draft.id, 'retirement.request.update')).toHaveLength(1);
  });

  it('AC-EN-F538-02 清空同时返聘的转交计划，生效后上下级与组织负责人仍保留（RT-R3）', async () => {
    const x = withRehire(database().db, await world('clear'));
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_保留下属');
    const receiver = await x.peer('ZZ_F538_接收人');
    const org = await x.headedOrg('ZZ_F538_保留负责人组织');
    const dutyTransfer = x.plan({
      subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }],
      orgRoles: [{ orgId: org.id, receiverId: receiver.id }],
    });
    const draft = await x.createdRehire(x.rehireBody(last, 'direct', x.rehirePlan(), { exit: { dutyTransfer } }));
    const response = await x.patchExit(draft.id, draft.revision, { dutyTransfer: null }, 'retirement');
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await detail(x, draft.id)).toHaveProperty('dutyTransferPlan', null);

    expect(await x.activate(draft.id, effective)).toMatchObject({ outcome: 'effective' });
    expect(await x.managerOf(subordinate.id, effective)).toBe(x.employee.id);
    expect(await x.headAt(org.id, effective)).toBe(x.employee.id);
    expect(await x.items(draft.id)).toEqual([]);
    expect(await x.exitRecords()).toEqual([]);
  });

  it('AC-EN-F538-03 人员不存在、跨租户及字段越界均回滚计划、业务、审计与命令台账', async () => {
    const x = await world('invalid');
    const other = await world('foreign');
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_校验下属');
    const receiver = await x.peer('ZZ_F538_校验接收人');
    const draft = await x.createdRetire(x.employee.id, retireBody(last));
    const t = x.session.tenant.id;
    const snapshot = async () => ({
      business: await x.stateOf(x.employee.id),
      ledger: await x.sqlRows(sql`SELECT command_type, command_id, request_hash, response_status FROM command_ledger
        WHERE tenant_id=${t} ORDER BY command_type, command_id`),
      linkage: await x.sqlRows(sql`SELECT id, version_no FROM transfer_linkage_versions WHERE tenant_id=${t}
        AND business_id=${draft.id}::uuid ORDER BY version_no`),
    });
    const plan = (id: string) => x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: id }] });
    const before = await snapshot();
    for (const dutyTransfer of [
      plan(randomUUID()),
      plan(other.employee.id),
      { ...plan(receiver.id), adjustSalary: true },
    ]) {
      const response = await x.patchExit(
        draft.id,
        draft.revision,
        { dutyTransfer, handoverEmployeeId: receiver.id },
        'retirement',
      );
      const data = await x.problem(response);
      expect(data).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      if (!Object.hasOwn(dutyTransfer, 'adjustSalary')) {
        expect.soft(data.reason).toBe('TRANSFER_PERSON_NOT_ELIGIBLE');
      }
      expect(await snapshot()).toEqual(before);
    }
  });

  it('AC-EN-F538-04 缺退休编辑按钮或目标字段编辑权均返回 403', async () => {
    const x = await world('permission');
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_授权下属');
    const receiver = await x.peer('ZZ_F538_授权接收人');
    const draft = await x.createdRetire(x.employee.id, retireBody(last));
    const body = { dutyTransfer: x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] }) };
    const before = await x.stateOf(x.employee.id);
    for (const authorize of [
      denyButtons('Employment.RetireEdit'),
      (request: Parameters<Authorizer>[0]) =>
        !(request.action === 'object.update' && request.fields?.includes('directManagerId')),
      (request: Parameters<Authorizer>[0]) =>
        !(request.action === 'object.update' && request.fields?.includes('dutyTransfer')),
    ]) {
      const response = await x.restricted(authorize)('PATCH', `/retirements/${draft.id}`, {
        body,
        ifMatch: draft.revision,
      });
      expect.soft(response.status, await response.clone().text()).toBe(403);
      expect(await x.stateOf(x.employee.id)).toEqual(before);
    }
  });
  it('AC-EN-F538-05 已生效及已作废的退休拒绝修改计划；离职 PATCH 仍拒绝该字段', async () => {
    const x = await world('closed');
    const active = await x.createdDirect('retirement', '2026-10-02');
    const applied = await x.activate(active.id, '2026-10-03');
    expect(applied).toMatchObject({ outcome: 'effective' });
    const other = await x.peer('ZZ_F538_撤销退休员工');
    const voided = await x.directRetire(last, undefined, other.id);
    const cancelled = await x.session.request('POST', `/retirements/${voided.id}/cancel`, {
      ifMatch: voided.revision,
      body: {},
    });
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    for (const [id, state] of [
      [active.id, 'effective'],
      [voided.id, 'voided'],
    ] as const) {
      expect(await x.stateOfBusiness(id)).toBe(state);
      const { revision, employeeId } = await x.business(id);
      const before = await x.stateOf(employeeId);
      expect(await x.problem(await x.patchExit(id, revision, { dutyTransfer: null }, 'retirement'))).toMatchObject({
        status: 409,
        reason: 'EXIT_NOT_EDITABLE',
      });
      expect(await x.stateOf(employeeId)).toEqual(before);
    }
    const leaver = await x.peer('ZZ_F538_离职员工');
    const leave = await x.createdLeave(leaver.id, x.bodyOf('leave', last, 'application'));
    const before = await x.stateOf(leaver.id);
    expect((await x.patchExit(leave.id, leave.revision, { dutyTransfer: null })).status).toBe(400);
    expect(await x.stateOf(leaver.id)).toEqual(before);
    expect((await x.patchExit(leave.id, leave.revision, { handoverEmployeeId: x.employee.id })).status).toBe(200);
  });

  it('AC-EN-F538-06 审批通过时已执行的计划保留原版，拒绝覆盖或清空', async () => {
    const x = await world('executed');
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_已转交下属');
    const receiver = await x.peer('ZZ_F538_已转交接收人');
    const dutyTransfer = x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] });
    await x.useTiming('approval_passed');
    const retire = await x.createdDirect('retirement', last, { dutyTransfer });
    const before = await x.stateOf(x.employee.id);
    expect(await detail(x, retire.id)).toMatchObject({ dutyTransferPlan: dutyTransfer, dutyTransferPlanLocked: true });
    expect(
      await x.problem(await x.patchExit(retire.id, retire.revision, { dutyTransfer: null }, 'retirement')),
    ).toMatchObject({ status: 409, reason: 'EXIT_DUTY_TRANSFER_LOCKED' });
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('AC-EN-F538-07 详情按字段与计划引用范围披露；同键重放重新核对职责权限', async () => {
    const x = await world('replay');
    const subordinate = await x.subordinateOf(x.employee.id, 'ZZ_F538_重放下属');
    const receiver = await x.peer('ZZ_F538_重放接收人');
    const draft = await x.directRetire(last, {
      dutyTransfer: x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: receiver.id }] }),
    });
    expect(await detail(x, draft.id, x.restricted(denyButtons()))).not.toHaveProperty('dutyTransferPlan');
    const ownerScope: Authorizer = () => true;
    registerScopeProvider(ownerScope, {
      scope: async () => ({
        ...EMPTY_SCOPE,
        hasDataPermission: true,
        terms: [{ dimension: 'reporting', orgIds: [], personIds: [x.employee.id, subordinate.id] }],
      }),
      authorize: async (request) => ownerScope(request),
      fields: async () => new Set(['id', 'employeeId', 'revision', 'dutyTransfer']),
    });
    const limited = await detail(x, draft.id, x.asUser(x.session.user.id, ownerScope));
    expect(limited).not.toHaveProperty('dutyTransferPlan');
    expect(limited).not.toHaveProperty('dutyTransferPlanLocked');

    const next = await x.peer('ZZ_F538_更换接收人');
    const path = `/retirements/${draft.id}`;
    const command = {
      ifMatch: draft.revision,
      idempotencyKey: randomUUID(),
      body: { dutyTransfer: x.plan({ subordinates: [{ employeeId: subordinate.id, receiverId: next.id }] }) },
    };
    const saved = await x.session.request('PATCH', path, command);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const reply = await saved.json();
    const before = await x.stateOf(x.employee.id);
    const replay = await x.session.request('PATCH', path, command);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(reply);
    const denyDutyField: Authorizer = (request) =>
      !(request.action === 'object.update' && request.fields?.includes('dutyTransfer'));
    expect((await x.restricted(denyDutyField)('PATCH', path, command)).status).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.activate(draft.id, effective)).toMatchObject({ outcome: 'effective' });
    expect(await x.managerOf(subordinate.id, effective)).toBe(next.id);
  });
});
