/**
 * R2-T03 B3-3 / AC-DM-17、32 ⑤：关口⑤拆除后，离职请求体接受 dutyTransfer（职责转交）。
 * 须先写联动版本、再调 confirmExit（approval_passed 时机的转交读的就是这个版本）；business_effective 时机在生效链步骤 6 执行。
 * B3-2 里转交计划是经联动版本造数写入、走内部入口验证；这里改经公开入口端到端（B-16、B-17、B-48、B-49 的公开路径）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import type { Authorizer } from '@italent/api';
import { describe, expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);
type World = Awaited<ReturnType<typeof world>>;

const duty = (subordinateId: string, receiverId: string) => ({
  dutyTransfer: { subordinates: [{ employeeId: subordinateId, receiverId, relation: 'direct' }], orgRoles: [] },
});
const dutyEffects = async (x: World, leaveId: string) =>
  (await x.effects(leaveId)).filter((row) => row.kind.startsWith('duty_')).map((row) => [row.phase, row.kind] as const);
const linkageVersions = async (x: World) =>
  Number(
    (
      await x.sqlRows<{ n: number }>(sql`SELECT count(*) AS n FROM transfer_linkage_versions
        WHERE tenant_id=${x.session.tenant.id} AND employee_id=${x.employee.id}::uuid`)
    )[0]!.n,
  );

async function people(x: World) {
  return { subordinate: await x.subordinateOf(x.employee.id, '下属'), receiver: await x.peer('接收人') };
}

describe('AC-DM-17 business_effective（默认时机）：保存只写计划，生效链步骤 6 执行', () => {
  it('未来直接离职：保存写联动版本、不转交；到期调度生效时转交，生效日 = 最终生效日，台账 effective 阶段', async () => {
    const x = await world('open-duty-future');
    const { subordinate, receiver } = await people(x);

    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-10', 'direct', duty(subordinate.id, receiver.id)),
    );

    expect(leave.status).toBe('approved');
    expect(await linkageVersions(x)).toBe(1);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
    expect(await x.items(leave.id)).toEqual([]);
    expect(await x.runScheduler('2026-10-11T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect(await x.managerOf(subordinate.id, '2026-10-11')).toBe(receiver.id);
    expect(await x.items(leave.id)).toMatchObject([{ status: 'succeeded', effective: '2026-10-11' }]);
    expect(await dutyEffects(x, leave.id)).toEqual([['effective', 'duty_transferred']]);
  });

  it('L 已过的直接离职：保存事务内生效并转交（B-48 立即），响应已是 effective', async () => {
    const x = await world('open-duty-past');
    const { subordinate, receiver } = await people(x);
    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-05', 'direct', duty(subordinate.id, receiver.id)),
    );
    expect(leave.status).toBe('effective');
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect(await x.items(leave.id)).toMatchObject([{ status: 'succeeded', effective: TODAY }]);
    expect(await dutyEffects(x, leave.id)).toEqual([['effective', 'duty_transferred']]);
  });
});

describe('AC-DM-17 approval_passed：confirmed 阶段读到保存时写入的联动版本', () => {
  it('B-49 未来直接离职：保存事务内转交，生效日 = 保存当天；到期生效不重复转交', async () => {
    const x = await world('open-duty-confirmed');
    const { subordinate, receiver } = await people(x);
    await x.useTiming('approval_passed');
    const leave = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-20', 'direct', duty(subordinate.id, receiver.id)),
    );
    expect(leave.status).toBe('approved');
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect(await x.items(leave.id)).toMatchObject([{ status: 'succeeded', effective: TODAY }]);
    expect(await dutyEffects(x, leave.id)).toEqual([['confirmed', 'duty_transferred']]);
    expect(await x.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect(await dutyEffects(x, leave.id)).toEqual([['confirmed', 'duty_transferred']]);
    expect(await x.items(leave.id)).toHaveLength(1);
  });

  it('B-17 申请离职：审批通过当天转交，离职仍 approved，撤销前清单以台账为准', async () => {
    const x = await world('open-duty-approval');
    const { subordinate, receiver } = await people(x);
    await x.useTiming('approval_passed');
    const draft = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-20', 'application', { exitTypeCode: 'voluntary', ...duty(subordinate.id, receiver.id) }),
    );
    expect(await linkageVersions(x)).toBe(1);
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
    await x.approve(draft, `${TODAY}T02:00:00Z`);
    expect(await x.stateOfBusiness(draft.id)).toBe('approved');
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect(await dutyEffects(x, draft.id)).toEqual([['confirmed', 'duty_transferred']]);
  });
});

describe('§9.1 职责转交保存：校验与授权，任一不通过整单不保存', () => {
  it('接收人已离职 / 下属不汇报给离职人 → 400，离职与联动都不保存', async () => {
    const x = await world('open-duty-invalid');
    const { subordinate, receiver } = await people(x);
    const departed = await x.peer('已离职接收人');
    await x.effectiveExit(departed.id, '2026-10-01');
    const stranger = await x.peer('不汇报给离职人');
    const before = await x.stateOf(x.employee.id);
    const send = async (subordinateId: string, receiverId: string) =>
      x.reason(await x.createLeave(x.employee.id, leaveBody('2026-10-20', 'direct', duty(subordinateId, receiverId))));
    expect(await send(subordinate.id, departed.id)).toMatchObject({
      status: 400,
      reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
    });
    expect(await send(stranger.id, receiver.id)).toMatchObject({
      status: 400,
      reason: 'TRANSFER_SUBORDINATE_NOT_REPORTING',
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await linkageVersions(x)).toBe(0);
  });

  it('无下属直线经理字段编辑权 → 403，整单不保存（离职、联动、预减都不留）', async () => {
    const x = await world('open-duty-403');
    const { subordinate, receiver } = await people(x);
    const denyManagerField: Authorizer = (request) =>
      !(request.action === 'object.update' && !!request.fields?.includes('directManagerId'));
    const before = await x.stateOf(x.employee.id);
    const response = await x.createLeave(
      x.employee.id,
      leaveBody('2026-10-20', 'direct', duty(subordinate.id, receiver.id)),
      x.restricted(denyManagerField),
    );
    expect(response.status, await response.clone().text()).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await linkageVersions(x)).toBe(0);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
  });
});
