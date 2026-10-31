/** F-302 / AC-DM-01、02 / B-60a：撤销离职清单列出真实交接单，处理复用 BE-8b2 撤销钩子，披露按当前权限。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  probeDownstream,
  trimDownstream,
  type Downstream,
} from '../../apps/api/src/modules/employment/exit-downstream.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { FUTURE_LAST_WORK_DATE, handoverWorld, TODAY, type HandoverWorld } from './AC-EXIT-handover-support.js';
import { orgScope } from './support/revocable-rights.js';

const database = useTestDb();
const handover = (downstream: Downstream) => downstream.items.find((item) => item.kind === 'handover')!;
const world = async (label: string) => {
  const x = await handoverWorld(database().db, `f302-${label}`);
  await x.addSettingItems();
  await x.publishHandoverProcess();
  return x;
};
const context = (x: HandoverWorld, scope?: ModuleScope): EmploymentContext => ({
  tenantId: x.tenantId,
  userId: x.session.user.id,
  timezone: x.session.tenant.timezone,
  now: new Date(`${TODAY}T02:00:00Z`),
  commandId: randomUUID(),
  expectedRevision: 0,
  scope,
});
const probe = (x: HandoverWorld, exitId: string, employeeId = x.employee.id) =>
  withTenant(x.db, x.tenantId, (tx) =>
    probeDownstream(tx, context(x), { businessId: exitId, employeeId, lastWorkDate: FUTURE_LAST_WORK_DATE }),
  );
async function readReceipt(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as { downstream: Downstream; cancellation: { id: string } };
}
async function cancel(x: HandoverWorld, exitId: string) {
  const options = {
    ifMatch: (await x.business(exitId)).revision,
    idempotencyKey: randomUUID(),
    body: { reason: '合成撤销原因' },
  };
  const path = `/exits/${exitId}/cancel`;
  const receipt = await readReceipt(await x.session.request('POST', path, options));
  return { receipt, path, options };
}
const target = (id: string, stateBefore: string) => ({
  type: 'exit-handover-request',
  id,
  detail: { stateBefore },
});

describe('AC-DM-01/02 / F-302 撤销离职的真实交接清单', () => {
  it('AC-DM-01 / B-60a 无交接单：handover 为 none，固定类目顺序与薪资占位不变', async () => {
    const x = await world('none');
    const leave = await x.createdExit(x.employee.id, FUTURE_LAST_WORK_DATE, 'direct', { exitTypeCode: 'voluntary' });
    const { receipt } = await cancel(x, leave.id);
    expect(receipt.downstream.items.map((item) => item.kind)).toEqual([
      'contract',
      'duty_transfer',
      'handover',
      'payroll',
      'part-time',
    ]);
    expect(handover(receipt.downstream)).toEqual({ kind: 'handover', status: 'none', targets: [], hiddenCount: 0 });
    expect(receipt.downstream.items.find((item) => item.kind === 'payroll')?.status).toBe('not_connected');
    expect(await x.requestRows(leave.id)).toEqual([]);
  });

  it('AC-DM-01 在途交接：列出撤销前快照，原钩子终止交接和审批，重放不重复处理', async () => {
    const x = await world('in-progress');
    const { exitId, request, instanceId } = await x.launched();
    const { receipt, path, options } = await cancel(x, exitId);
    expect(handover(receipt.downstream)).toEqual({
      kind: 'handover',
      status: 'found',
      targets: [target(request.id, 'in_progress')],
      hiddenCount: 0,
    });
    expect(await x.requestRows(exitId)).toEqual([
      expect.objectContaining({ id: request.id, state: 'terminated', endReason: 'exit_cancelled' }),
    ]);
    expect(await x.instanceStatus(instanceId)).toBe('cancelled');
    expect(await x.pendingTasks(instanceId)).toEqual([]);
    const [stored] = await x.sqlRows<{ downstream: Downstream }>(sql`
      SELECT downstream FROM exit_cancellations WHERE tenant_id=${x.tenantId} AND business_id=${exitId}::uuid`);
    expect(stored?.downstream).toEqual(receipt.downstream);
    expect(await readReceipt(await x.session.request('POST', path, options))).toEqual(receipt);
    expect(await x.auditActions(request.id, 'exit_handover.terminate')).toHaveLength(1);
    expect(await x.auditActions(exitId, 'exit.request.cancel')).toHaveLength(1);
  });

  it('AC-DM-02 已生效离职、已完成交接：清单保留交接记录，不改交接或审批状态', async () => {
    const x = await world('completed');
    const { exitId, request, instanceId } = await x.launched();
    await x.approveAll(instanceId);
    await x.activate(exitId, '2026-10-11');
    x.setNow('2026-10-12T02:00:00Z');
    const before = await x.requestRows(exitId);
    const { receipt } = await cancel(x, exitId);
    expect(handover(receipt.downstream)).toEqual({
      kind: 'handover',
      status: 'found',
      targets: [target(request.id, 'completed')],
      hiddenCount: 0,
    });
    expect(await x.requestRows(exitId)).toEqual(before);
    expect(await x.instanceStatus(instanceId)).toBe('approved');
    expect(await x.auditActions(request.id, 'exit_handover.terminate')).toEqual([]);
  });

  it.each(['not_launched', 'terminated'] as const)('AC-DM-01 %s 交接也列出，未发起收回、已终止保留', async (state) => {
    const x = await world(state);
    const { approved } = await x.approvedApplication(x.employee.id, {
      exit: state === 'not_launched' ? { handoverEmployeeId: undefined } : {},
    });
    const [request] = await x.requestRows(approved.id);
    if (state === 'terminated') expect((await x.decide(request!.instanceId!, 'disagree')).status).toBe(200);
    const beforeAudits = await x.auditActions(request!.id, 'exit_handover.terminate');
    const { receipt } = await cancel(x, approved.id);
    expect(handover(receipt.downstream).targets).toEqual([target(request!.id, state)]);
    expect((await x.requestRows(approved.id))[0]).toMatchObject({
      state: 'terminated',
      endReason: state === 'not_launched' ? 'exit_cancelled' : 'disapproved',
    });
    expect(await x.auditActions(request!.id, 'exit_handover.terminate')).toHaveLength(
      beforeAudits.length + (state === 'not_launched' ? 1 : 0),
    );
  });

  it('DEC-177 范围逐次裁剪：空范围、无关部门隐藏；当前部门与离职创建者可见，不以交接发起人代替创建者', async () => {
    const x = await world('scope');
    const { exitId, request } = await x.launched();
    const raw = await probe(x, exitId);
    const creatorScope = (creatorId: string): ModuleScope => ({
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      terms: [{ dimension: 'using_user', orgIds: [], personIds: [], creatorId }],
    });
    const scopes: readonly [ModuleScope, boolean][] = [
      [EMPTY_SCOPE, false],
      [orgScope(x.tenantId, TODAY, x.to.id), false],
      [orgScope(x.tenantId, TODAY, x.from.id), true],
      [creatorScope(x.session.user.id), true],
      [creatorScope(x.leaverUserId), false],
    ];
    for (const [scope, visible] of scopes) {
      const trimmed = await withTenant(x.db, x.tenantId, (tx) =>
        trimDownstream(tx, context(x, scope), raw, x.employee.id),
      );
      expect(handover(trimmed)).toEqual({
        kind: 'handover',
        status: 'found',
        targets: visible ? [target(request.id, 'in_progress')] : [],
        hiddenCount: visible ? 0 : 1,
      });
    }
  });

  it('B-60a 撤销重放按当前对象查看权和字段权裁剪，不回传台账中的交接 ID', async () => {
    const x = await world('replay-rights');
    const { exitId, request } = await x.launched();
    const { receipt, path, options } = await cancel(x, exitId);
    expect(handover(receipt.downstream).targets).toEqual([target(request.id, 'in_progress')]);
    const readers = [
      x.restricted((r) => !(r.action === 'object.view' && r.resource === MODULE_OBJECTS.employmentRecord.code)),
      x.restricted(() => true, undefined, ['status', 'revision']),
    ];
    for (const read of readers) {
      const replay = await readReceipt(await read('POST', path, options));
      expect(handover(replay.downstream)).toEqual({
        kind: 'handover',
        status: 'found',
        targets: [],
        hiddenCount: 1,
      });
      expect(JSON.stringify(replay)).not.toContain(request.id);
    }
    const withoutStatus = x.restricted(() => true, undefined, ['id', 'revision']);
    const partial = await readReceipt(await withoutStatus('POST', path, options));
    expect(handover(partial.downstream)).toEqual({
      kind: 'handover',
      status: 'found',
      targets: [{ type: 'exit-handover-request', id: request.id }],
      hiddenCount: 0,
    });
    expect(await x.auditActions(request.id, 'exit_handover.terminate')).toHaveLength(1);
  });

  it('F-302 探针只查本租户、本离职与员工的交接单，不混入其他离职或其他租户', async () => {
    const x = await world('isolation');
    const foreign = await world('foreign');
    const own = await x.launched();
    const other = await x.launched(x.workOwner.employeeId, { handoverEmployeeId: x.hrbp.employeeId });
    const remote = await foreign.launched();
    expect(handover(await probe(x, own.exitId)).targets.map((t) => t.id)).toEqual([own.request.id]);
    for (const exitId of [other.exitId, remote.exitId, randomUUID()])
      expect(handover(await probe(x, exitId))).toEqual({
        kind: 'handover',
        status: 'none',
        targets: [],
        hiddenCount: 0,
      });
  });
});
