/**
 * R2-T03 B4 / AC-DM-01、02、22、29：撤销的入口与权限（设计 §4 / §7.2 / §7.3 / §9.1）。
 * 通用 DELETE / revoke 对离职不再是 B4 前的 409 EXIT_OPERATION_NOT_AVAILABLE（§18.1 末段）：revoke 409 USE_EXIT_CANCEL，
 * DELETE 与专用撤销同一实现（不留绕过 §6B 的删除路径）；restore 授权先于不支持（B-57）；修改撤销原因（B-76）；
 * 撤销清单按查看人裁剪（B-60a）；任职状态钩子（B-75 删除一侧、AC-DM-29）与 BE-8 撤销端口（B-59）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { exitPostEffectHooks } from '../../apps/api/src/modules/employment/exit-confirmation.js';
import { registerEmployeeStatusHooks } from '../../apps/api/src/modules/employment/status-hooks.js';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { denyButtons, leaveBody } from './AC-EXIT-gate-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => cancelWorld(database().db, label, TODAY);

describe('§4 通用入口映射：不留绕过 §6B 的删除路径', () => {
  it.each(['in_review', 'approved', 'effective'] as const)(
    '通用 revoke 对离职单（%s）→ 409 USE_EXIT_CANCEL，无写入',
    async (state) => {
      const x = await world(`entry-revoke-${state}`);
      const leave =
        state === 'in_review'
          ? await x.submittedLeave('2026-10-20')
          : state === 'approved'
            ? await x.directLeave('2026-10-25')
            : await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
      const before = await x.stateOf(x.employee.id);
      const response = await x.session.request('POST', `/businesses/${leave.id}/revoke`, {
        ifMatch: (await x.business(leave.id)).revision,
        body: {},
      });
      expect(await x.reason(response)).toMatchObject({ status: 409, reason: 'USE_EXIT_CANCEL' });
      expect(await x.stateOf(x.employee.id)).toEqual(before);
    },
  );

  it('通用 DELETE 对离职单与专用撤销同一实现：带原因成功（已批准 / 已生效），缺原因 400', async () => {
    const x = await world('entry-delete');
    const approved = await x.directLeave('2026-10-25');
    const remove = async (id: string, body?: object) =>
      x.session.request('DELETE', `/businesses/${id}`, {
        ifMatch: (await x.business(id)).revision,
        ...(body ? { body } : {}),
      });
    expect(await x.reason(await remove(approved.id))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const removed = await remove(approved.id, { reason: '误录入' });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(approved.id)).toBe('voided');
    expect(await x.cancellationOf(approved.id)).toMatchObject({ case: 'approved_voided', reason: '误录入' });

    const effective = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    const reinstated = await remove(effective.id, { reason: '误办理' });
    expect(reinstated.status, await reinstated.clone().text()).toBe(200);
    expect(await x.cancellationOf(effective.id)).toMatchObject({ case: 'record_deleted_reinstated' });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });

  it('已作废的离职单通用 DELETE 仍是清理（置删除），不是撤销：不写撤销记录', async () => {
    const x = await world('entry-delete-voided');
    const leave = await x.directLeave('2026-10-25');
    await x.cancelled(leave.id);
    const removed = await x.session.request('DELETE', `/businesses/${leave.id}`, {
      ifMatch: (await x.business(leave.id)).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(leave.id)).toBe('deleted');
    expect((await x.cancellationOf(leave.id))!.revision).toBe(1);
  });
});

describe('B-57 restore：授权先于不支持', () => {
  it('无按钮 403；范围外 404；有权限 409 EXIT_RESTORE_NOT_SUPPORTED；均无写入', async () => {
    const x = await world('entry-restore');
    const leave = await x.directLeave('2026-10-25');
    await x.cancelled(leave.id);
    const before = await x.stateOf(x.employee.id);
    const restore = (api: typeof x.session.request) =>
      api('POST', `/exits/${leave.id}/restore`, { ifMatch: 1, body: {} });

    expect((await restore(x.restricted(denyButtons('Employment.DimissionCancel')))).status).toBe(403);
    const other = await x.otherUser();
    const outOfScope = x.restricted(denyButtons(), other.id);
    expect((await restore(outOfScope)).status).toBe(404);
    expect(await x.reason(await restore(x.session.request))).toMatchObject({
      status: 409,
      reason: 'EXIT_RESTORE_NOT_SUPPORTED',
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });
});

describe('B-76 PATCH exits/cancellations/:id 修改撤销原因（DM-R5）', () => {
  it('有 DimissionCancel + 范围 → 200 revision +1、审计 exit.cancellation.update；其余列不可改', async () => {
    const x = await world('entry-patch');
    const leave = await x.directLeave('2026-10-25');
    const result = await x.cancelled(leave.id, { reason: '原原因' });
    const patch = (body: object, ifMatch = result.cancellation.revision, api = x.session.request) =>
      api('PATCH', `/exits/cancellations/${result.cancellation.id}`, { ifMatch, body });

    const updated = await patch({ reason: '  新原因  ' });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({ id: result.cancellation.id, reason: '新原因', revision: 2 });
    expect(await x.cancellationOf(leave.id)).toMatchObject({
      reason: '新原因',
      revision: 2,
      case: 'approved_voided',
      stateBefore: 'approved',
    });
    expect(await x.auditActions(result.cancellation.id)).toContain('exit.cancellation.update');
    // 撤销视图（B5）读到修改后的原因
    const view = await x.session.request('GET', '/exits?view=cancellations');
    expect(
      ((await view.json()) as { items: { cancellation: { reason: string } }[] }).items[0]!.cancellation.reason,
    ).toBe('新原因');

    expect(await x.reason(await patch({ reason: '再改' }, 1))).toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
    });
    for (const body of [{}, { reason: '' }, { reason: 'x', case: 'approved_voided' }])
      expect(await x.reason(await patch(body, 2))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('无 DimissionCancel → 403；范围外 → 404；不存在 → 404；均不改原因', async () => {
    const x = await world('entry-patch-auth');
    const leave = await x.directLeave('2026-10-25');
    const result = await x.cancelled(leave.id, { reason: '原原因' });
    const patch = (api: typeof x.session.request, id = result.cancellation.id) =>
      api('PATCH', `/exits/cancellations/${id}`, { ifMatch: 1, body: { reason: '篡改' } });
    expect((await patch(x.restricted(denyButtons('Employment.DimissionCancel')))).status).toBe(403);
    const other = await x.otherUser();
    expect((await patch(x.restricted(denyButtons(), other.id))).status).toBe(404);
    expect((await patch(x.session.request, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await x.cancellationOf(leave.id))!.reason).toBe('原原因');
  });
});

describe('B-64 撤销的权限链：功能权 → 按钮权 → 范围', () => {
  it('无 DimissionCancel → 403；有按钮无对象 update 功能权 → 403；范围外 → 404；均无写入', async () => {
    const x = await world('entry-perm');
    const leave = await x.directLeave('2026-10-25');
    const before = await x.stateOf(x.employee.id);
    const send = (api: typeof x.session.request) =>
      api('POST', `/exits/${leave.id}/cancel`, { ifMatch: 1, body: { reason: '撤销' } });
    expect((await send(x.restricted(denyButtons('Employment.DimissionCancel')))).status).toBe(403);
    expect((await send(x.restricted((request) => request.action !== 'object.update'))).status).toBe(403);
    const other = await x.otherUser();
    expect((await send(x.restricted(denyButtons(), other.id))).status).toBe(404);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });

  it('撤权后同键重放 → 403，不返回缓存的原响应', async () => {
    const x = await world('entry-replay');
    const leave = await x.directLeave('2026-10-25');
    const key = 'cancel-revoked-replay';
    const first = await x.session.request('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '撤销' },
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const revoked = x.restricted(denyButtons('Employment.DimissionCancel'));
    const replay = await revoked('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: 1,
      body: { reason: '撤销' },
      idempotencyKey: key,
    });
    expect(replay.status).toBe(403);
  });
});

describe('B-60a 撤销清单按查看人裁剪', () => {
  it('无合同对象查看权的撤销人：合同目标只计 hiddenCount，类目与状态仍在', async () => {
    const x = await world('entry-trim');
    const labor = await x.contractType('劳动合同');
    await x.createContract(labor);
    const leave = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    const hr = x.restricted(
      (request) => !(request.action === 'object.view' && String(request.resource).includes('Contract')),
    );

    const response = await hr('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '撤销' },
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      downstream: { items: { kind: string; status: string; targets: unknown[]; hiddenCount: number }[] };
    };
    const contract = body.downstream.items.find((entry) => entry.kind === 'contract')!;
    expect(contract).toMatchObject({ status: 'found', targets: [], hiddenCount: 1 });
  });
});

describe('AC-DM-29 / B-59 任职状态钩子与 BE-8 撤销端口', () => {
  const deleted: { recordId: string; kind: string }[] = [];
  const cancelled: { businessId: string; stateBefore: string; case: string }[] = [];
  registerEmployeeStatusHooks('b4-cancel-test', {
    onRecordDeleted: async (_tx, _ctx, event) => void deleted.push({ recordId: event.recordId, kind: event.kind }),
  });
  exitPostEffectHooks.onCancelled(async (_tx, _ctx, event) => void cancelled.push(event));

  it('撤销已生效离职通知 onRecordDeleted 一次；撤销 approved / 未办结只走撤销端口，不通知记录删除', async () => {
    const x = await world('entry-hooks');
    deleted.length = 0;
    cancelled.length = 0;
    const approved = await x.directLeave('2026-10-25');
    await x.cancelled(approved.id);
    expect(deleted).toEqual([]);
    expect(cancelled.at(-1)).toMatchObject({
      businessId: approved.id,
      stateBefore: 'approved',
      case: 'approved_voided',
    });

    const effective = await x.createdLeave(x.employee.id, leaveBody('2026-10-05', 'direct'));
    await x.cancelled(effective.id);
    expect(deleted).toEqual([{ recordId: effective.id, kind: 'leave' }]);
    expect(cancelled.at(-1)).toMatchObject({
      businessId: effective.id,
      stateBefore: 'effective',
      case: 'record_deleted_reinstated',
    });
  });
});
