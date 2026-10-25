/**
 * R2-T03 B3-2 / AC-DM-17：离职职责转交两种时机与 DM-R14（设计 §5.7，原 BE-9 并入）。
 * 请求体里的 dutyTransfer 区块在 B3-3 前仍被关口⑤拒绝，所以转交计划经联动版本造数写入，
 * business_effective 经 activateExit 步骤 6，approval_passed 经 confirmExit（审批通过 / 直接离职保存的 confirmed 阶段）。
 * 覆盖 B-16、B-17（执行部分）、B-48、B-49 与 transfer-locks participants 纳入 kind = leave。
 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { lockTransferParticipants } from '../../apps/api/src/modules/employment/transfer-locks.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { dayAt } from './AC-EXIT-activation-support.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => downstreamWorld(database().db, label, TODAY);

const dutyEffects = async (x: Awaited<ReturnType<typeof world>>, leaveId: string) =>
  (await x.effects(leaveId)).filter((row) => row.kind.startsWith('duty_'));

describe('AC-DM-17 business_effective：生效时（步骤 6）', () => {
  it('子项各自执行：下属直线经理改为接收人，台账 duty_transferred，item 生效日 = 最终生效日；幂等不重复', async () => {
    const x = await world('duty-effective');
    const [s1, s2, receiver] = [
      await x.subordinateOf(x.employee.id, '下属一'),
      await x.subordinateOf(x.employee.id, '下属二'),
      await x.peer('接收人'),
    ];
    const leave = await x.directLeave('2026-10-05');
    await x.planDuties(leave.id, [
      { employeeId: s1.id, receiverId: receiver.id },
      { employeeId: s2.id, receiverId: receiver.id },
    ]);
    expect(await x.managerOf(s1.id)).toBe(x.employee.id);
    expect(await dutyEffects(x, leave.id)).toEqual([]);

    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });

    expect([await x.managerOf(s1.id), await x.managerOf(s2.id)]).toEqual([receiver.id, receiver.id]);
    expect((await x.items(leave.id)).map((item) => [item.status, item.effective])).toEqual([
      ['succeeded', TODAY],
      ['succeeded', TODAY],
    ]);
    const effects = await dutyEffects(x, leave.id);
    expect(effects.map((row) => [row.phase, row.kind])).toEqual([
      ['effective', 'duty_transferred'],
      ['effective', 'duty_transferred'],
    ]);
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');
  });

  it('B-16 接收人已离职：该子项 duty_failed，离职照常生效，下属汇报线不变', async () => {
    const x = await world('b16');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('已离职接收人');
    await x.effectiveExit(receiver.id, '2026-10-01');
    const leave = await x.directLeave('2026-10-05');
    await x.planDuties(leave.id, [{ employeeId: subordinate.id, receiverId: receiver.id }]);
    expect(await x.activate(leave.id, TODAY)).toMatchObject({ outcome: 'effective' });
    expect(await x.stateOfBusiness(leave.id)).toBe('effective');
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);
    expect(await x.items(leave.id)).toEqual([
      expect.objectContaining({ status: 'failed', rule: 'TRANSFER_PERSON_NOT_ELIGIBLE' }),
    ]);
    expect((await dutyEffects(x, leave.id)).map((row) => row.kind)).toEqual(['duty_failed']);
  });

  it('没有转交计划的离职不产生转交台账与联动执行行', async () => {
    const x = await world('duty-none');
    const leave = await x.directLeave('2026-10-05');
    await x.activate(leave.id, TODAY);
    expect(await dutyEffects(x, leave.id)).toEqual([]);
    expect(await x.items(leave.id)).toEqual([]);
  });
});

describe('AC-DM-17 approval_passed：确认阶段（审批通过 / 直接离职保存）', () => {
  it('B-17 申请离职审批通过当天执行转交（生效日 = 批准当天），离职仍 approved；到期生效不重复转交', async () => {
    const x = await world('b17');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    await x.useTiming('approval_passed');
    const draft = await x.createdLeave(
      x.employee.id,
      leaveBody('2026-10-20', 'application', { exitTypeCode: 'voluntary' }),
    );
    const sent = await x.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await x.planDuties(draft.id, [{ employeeId: subordinate.id, receiverId: receiver.id }]);
    expect(await x.managerOf(subordinate.id)).toBe(x.employee.id);

    await x.approve(draft, dayAt(TODAY).toISOString());

    expect(await x.stateOfBusiness(draft.id)).toBe('approved');
    expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
    expect((await dutyEffects(x, draft.id)).map((row) => [row.phase, row.kind])).toEqual([
      ['confirmed', 'duty_transferred'],
    ]);
    expect((await x.items(draft.id))[0]).toMatchObject({ status: 'succeeded', effective: TODAY });

    expect(await x.activate(draft.id, '2026-10-21')).toMatchObject({ outcome: 'effective' });
    expect((await dutyEffects(x, draft.id)).map((row) => [row.phase, row.kind])).toEqual([
      ['confirmed', 'duty_transferred'],
    ]);
    expect(await x.items(draft.id)).toHaveLength(1);
  });

  it.each([
    ['B-48 立即（L 已过）', '2026-10-05'],
    ['B-49 未来（L 在后）', '2026-10-20'],
  ])(
    '%s：直接离职保存事务内 confirmed 转交，生效日 = 保存当天；不触发交接自动发起端口（DM-R14）',
    async (_name, last) => {
      const x = await world(`direct-${last}`);
      const confirmedModes: string[] = [];
      exitPostEffectHooks.onConfirmed(async (_tx, _ctx, event) => void confirmedModes.push(event.mode));
      const subordinate = await x.subordinateOf(x.employee.id, '下属');
      const receiver = await x.peer('接收人');
      await x.useTiming('approval_passed');
      const leave = await x.directLeave(last);
      await x.planDuties(leave.id, [{ employeeId: subordinate.id, receiverId: receiver.id }]);

      await x.confirm(leave.id, TODAY);

      expect(await x.managerOf(subordinate.id)).toBe(receiver.id);
      expect(await x.stateOfBusiness(leave.id)).toBe('approved');
      expect((await x.items(leave.id))[0]).toMatchObject({ status: 'succeeded', effective: TODAY });
      expect(confirmedModes.filter((mode) => mode === 'direct')).toEqual([]);

      const at = last < TODAY ? TODAY : '2026-10-21';
      expect(await x.activate(leave.id, at)).toMatchObject({ outcome: 'effective' });
      expect((await dutyEffects(x, leave.id)).map((row) => [row.phase, row.kind])).toEqual([
        ['confirmed', 'duty_transferred'],
      ]);
    },
  );

  it('申请离职审批通过会调用交接自动发起端口一次（对比 DM-R14）', async () => {
    const x = await world('r14-application');
    const modes: string[] = [];
    exitPostEffectHooks.onConfirmed(async (_tx, _ctx, event) => void modes.push(event.mode));
    await x.approvedLeave('2026-10-20', TODAY);
    expect(modes).toEqual(['application']);
  });
});

describe('transfer-locks participants 纳入 kind = leave 的转交下属（§5.2 ①）', () => {
  it('未执行的离职把转交下属并入员工锁集合；执行后（run 已存在）不再并入', async () => {
    const x = await world('participants');
    const subordinate = await x.subordinateOf(x.employee.id, '下属');
    const receiver = await x.peer('接收人');
    const leave = await x.directLeave('2026-10-05');
    await x.planDuties(leave.id, [{ employeeId: subordinate.id, receiverId: receiver.id }]);
    const held = () =>
      withTenant(database().db, x.session.tenant.id, async (tx) => {
        const ctx = {
          tenantId: x.session.tenant.id,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: dayAt(TODAY),
          commandId: randomUUID(),
          expectedRevision: 0,
        };
        await lockTransferParticipants(tx, ctx, x.employee.id);
        const [row] = rowsOf<{ value: string }>(
          await tx.execute(
            sql`SELECT current_setting('italent.transfer_employee_locks_' ||
              replace(current_setting('app.tenant_id'),'-',''), true) AS value`,
          ),
        );
        return (JSON.parse(row!.value) as string[]).sort();
      });
    expect(await held()).toEqual([x.employee.id, subordinate.id].sort());
    await x.activate(leave.id, TODAY);
    expect(await held()).toEqual([x.employee.id]);
  });
});
