/**
 * R2-T04 BE-5a′ / AC-RT-11b：撤销入口与重放（设计 §6 接线点 1～4、7，§12.1）。
 * 专用入口 POST retirements/:id/cancel、restore、PATCH retirements/cancellations/:id 与离职同一实现；通用 DELETE businesses/:id
 * 对退休单走撤销；同幂等键对专用入口与通用 DELETE 重放都得首次回执；业务类型与路径不一致一律 404；通用 revoke 409 USE_EXIT_CANCEL。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retireBody } from './AC-RT-support.js';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementCancelWorld(database().db, label, TODAY);

describe('AC-RT-11b 通用入口映射：退休单不留绕过 §6B 的删除路径', () => {
  it.each(['in_review', 'approved', 'effective'] as const)(
    '通用 revoke 对退休单（%s）→ 409 USE_EXIT_CANCEL 并指向 retirements/:id/cancel，无写入',
    async (state) => {
      const x = await world(`rt11b-revoke-${state}`);
      const retire =
        state === 'in_review'
          ? await x.submittedRetire('2026-10-20')
          : state === 'approved'
            ? await x.directRetire('2026-10-25')
            : await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
      const before = await x.stateOf(x.employee.id);
      const response = await x.session.request('POST', `/businesses/${retire.id}/revoke`, {
        ifMatch: (await x.business(retire.id)).revision,
        body: {},
      });
      expect(await x.reason(response)).toMatchObject({
        status: 409,
        reason: 'USE_EXIT_CANCEL',
        endpoint: 'POST /retirements/:id/cancel',
      });
      expect(await x.stateOf(x.employee.id)).toEqual(before);
    },
  );

  it('通用 DELETE 对退休单与专用撤销同一实现：带原因成功（已批准 / 已生效），缺原因 400', async () => {
    const x = await world('rt11b-delete');
    const approved = await x.directRetire('2026-10-25');
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

    const effective = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    const reinstated = await remove(effective.id, { reason: '误办理' });
    expect(reinstated.status, await reinstated.clone().text()).toBe(200);
    expect(await x.cancellationOf(effective.id)).toMatchObject({ case: 'record_deleted_reinstated' });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect((await x.retirementDates()).actual).toBeNull();
  });

  it('通用 DELETE 对未办结退休（草稿 / 审批中）也走撤销，写撤销记录', async () => {
    const x = await world('rt11b-delete-process');
    const draft = await x.createdRetire(x.employee.id, retireBody('2026-10-20', 'application'));
    const removed = await x.session.request('DELETE', `/businesses/${draft.id}`, {
      ifMatch: (await x.business(draft.id)).revision,
      body: { reason: '不办了' },
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await x.cancellationOf(draft.id)).toMatchObject({ case: 'process_voided', stateBefore: 'draft' });
  });

  it('已作废的退休单通用 DELETE 仍是清理（置删除），不是撤销：不写新的撤销记录', async () => {
    const x = await world('rt11b-delete-voided');
    const retire = await x.directRetire('2026-10-25');
    await x.retireCancelled(retire.id);
    const removed = await x.session.request('DELETE', `/businesses/${retire.id}`, {
      ifMatch: (await x.business(retire.id)).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(retire.id)).toBe('deleted');
    expect((await x.cancellationOf(retire.id))!.revision).toBe(1);
  });
});

describe('AC-RT-11b 幂等重放：专用入口与通用 DELETE 各自同键重放都得首次回执', () => {
  it('专用入口：同键重放返回首次回执，不重复写入', async () => {
    const x = await world('rt11b-replay');
    const retire = await x.directRetire('2026-10-25');
    const revision = (await x.business(retire.id)).revision;
    const send = () =>
      x.cancelRetire(retire.id, { reason: '原因' }, { ifMatch: revision, idempotencyKey: 'rt-replay-1' });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const after = await x.stateOf(x.employee.id);

    const again = await send();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(await x.stateOf(x.employee.id)).toEqual(after);
    expect((await x.cancellationOf(retire.id))!.revision).toBe(1);
  });

  it('通用 DELETE：首次撤销后状态已变，同键重放仍走撤销分支，得首次回执（不是清理删除）', async () => {
    const x = await world('rt11b-replay-delete');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    const revision = (await x.business(retire.id)).revision;
    const send = () =>
      x.session.request('DELETE', `/businesses/${retire.id}`, {
        ifMatch: revision,
        body: { reason: '原因' },
        idempotencyKey: 'rt-replay-2',
      });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = await first.json();
    const after = await x.stateOf(x.employee.id);

    const again = await send();
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toEqual(firstBody);
    expect(await x.stateOfBusiness(retire.id)).toBe('deleted');
    expect(await x.stateOf(x.employee.id)).toEqual(after);
    expect((await x.cancellationOf(retire.id))!.revision).toBe(1);
  });
});

describe('AC-RT-11b 路径的业务类型与单据 kind 一致', () => {
  it('retirements/:id/cancel 对离职单 404；exits/:id/cancel 对退休单 404；均无写入', async () => {
    const x = await world('rt11b-kind');
    const leave = await x.directLeave('2026-10-25');
    const retire = await x.directRetire('2026-10-26', undefined, (await x.newcomer('另一人')).id);
    const before = await x.stateOf(x.employee.id);

    expect(await x.reason(await x.cancelRetire(leave.id))).toMatchObject({ status: 404 });
    expect(await x.reason(await x.cancel(retire.id))).toMatchObject({ status: 404 });
    expect(
      await x.reason(await x.session.request('POST', `/retirements/${leave.id}/restore`, { ifMatch: 1, body: {} })),
    ).toMatchObject({ status: 404 });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');
  });

  it('调动单走 retirements/:id/cancel → 404', async () => {
    const x = await world('rt11b-transfer');
    const transfer = await x.transferIn('draft', '2026-10-20');
    expect(await x.reason(await x.cancelRetire(transfer.id))).toMatchObject({ status: 404 });
  });
});

describe('AC-RT-11b restore：授权先于不支持', () => {
  it('范围外 404；有权限 409 EXIT_RESTORE_NOT_SUPPORTED；无写入', async () => {
    const x = await world('rt11b-restore');
    const retire = await x.directRetire('2026-10-25');
    await x.retireCancelled(retire.id);
    const before = await x.stateOf(x.employee.id);
    const restore = (api: typeof x.session.request) =>
      api('POST', `/retirements/${retire.id}/restore`, { ifMatch: 1, body: {} });

    const other = await x.otherUser();
    expect((await restore(x.restricted(denyButtons(), other.id))).status).toBe(404);
    expect(await x.reason(await restore(x.session.request))).toMatchObject({
      status: 409,
      reason: 'EXIT_RESTORE_NOT_SUPPORTED',
    });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });
});

describe('AC-RT-11b PATCH retirements/cancellations/:id 修改撤销原因', () => {
  it('revision 乐观锁；只有 reason 可改；退休与离职的撤销记录各走各的路径（互相 404）', async () => {
    const x = await world('rt11b-patch');
    const retire = await x.directRetire('2026-10-25');
    const result = await x.retireCancelled(retire.id, { reason: '原原因' });
    const patch = (path: string, body: object, ifMatch = result.cancellation.revision) =>
      x.session.request('PATCH', `${path}/${result.cancellation.id}`, { ifMatch, body });

    const updated = await patch('/retirements/cancellations', { reason: '  新原因  ' });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({ id: result.cancellation.id, reason: '新原因', revision: 2 });
    expect(await x.auditActions(result.cancellation.id)).toContain('exit.cancellation.update');
    expect(await x.reason(await patch('/retirements/cancellations', { reason: '再改' }, 1))).toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
    });
    for (const body of [{}, { reason: '' }, { reason: 'x', case: 'approved_voided' }])
      expect(await x.reason(await patch('/retirements/cancellations', body, 2))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    // 退休的撤销记录不能经离职路径改，反之亦然
    expect((await patch('/exits/cancellations', { reason: '串号' }, 2)).status).toBe(404);
    const colleague = await x.newcomer('另一人');
    const leave = await x.directLeave('2026-10-28', undefined, colleague.id);
    const leaveResult = await x.cancelled(leave.id, { reason: '离职原因' });
    const crossed = await x.session.request('PATCH', `/retirements/cancellations/${leaveResult.cancellation.id}`, {
      ifMatch: 1,
      body: { reason: '串号' },
    });
    expect(crossed.status).toBe(404);
    expect((await x.cancellationOf(leave.id))!.reason).toBe('离职原因');
    expect((await x.cancellationOf(retire.id))!.reason).toBe('新原因');
  });
});

describe('AC-RT-11b 撤销回执形状与离职一致', () => {
  it('回执 = 业务头 + cancellation + downstream 固定四类', async () => {
    const x = await world('rt11b-receipt');
    const retire = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    const result = await x.retireCancelled(retire.id);
    expect(result.downstream.items.map((entry) => entry.kind)).toEqual([
      'contract',
      'duty_transfer',
      'handover',
      'payroll',
    ]);
    expect(Object.keys(result.cancellation).sort()).toEqual(
      ['case', 'createdAt', 'id', 'reason', 'revision', 'stateBefore'].sort(),
    );
  });
});
