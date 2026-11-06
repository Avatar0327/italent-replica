/**
 * F-351 ③ / DEC-714：撤销退休（入口「删除任职」，含 DELETE businesses/:id）不收撤销原因、不提供原因修改；
 * 只作用于退休，撤销离职保持必填原因（AC-RT-11b / AC-EXIT-cancel-* 不变）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { retireBody } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementCancelWorld(database().db, label, TODAY);

describe('F-351 撤销退休不收原因（DEC-714）', () => {
  it('专用入口：不带 body 即可撤销，撤销记录的原因为空，回执与视图都不带原因', async () => {
    const x = await world('f351-cancel-plain');
    const retire = await x.directRetire('2026-10-25');
    const response = await x.session.request('POST', `/retirements/${retire.id}/cancel`, {
      ifMatch: (await x.business(retire.id)).revision,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const receipt = (await response.json()) as { cancellation: { reason: unknown; case: string } };
    expect(receipt.cancellation).toMatchObject({ case: 'approved_voided', reason: null });
    expect(await x.cancellationOf(retire.id)).toMatchObject({ case: 'approved_voided', reason: null });
  });

  it('专用入口：带 reason 一律 400（不收原因，不是静默忽略），无任何写入', async () => {
    const x = await world('f351-cancel-reject');
    const retire = await x.directRetire('2026-10-25');
    const before = await x.stateOf(x.employee.id);
    const response = await x.cancelRetire(retire.id, { reason: '录入有误' });
    expect(await x.reason(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await x.stateOfBusiness(retire.id)).toBe('approved');
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.cancellationOf(retire.id)).toBeUndefined();
  });

  it('通用 DELETE（删除任职）：已批准 / 已生效 / 草稿都不带原因即撤销，带 reason 400', async () => {
    const x = await world('f351-delete');
    const remove = async (id: string, body?: object) =>
      x.session.request('DELETE', `/businesses/${id}`, {
        ifMatch: (await x.business(id)).revision,
        ...(body ? { body } : {}),
      });
    const approved = await x.directRetire('2026-10-25');
    expect(await x.reason(await remove(approved.id, { reason: '误录入' }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    const removed = await remove(approved.id);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await x.cancellationOf(approved.id)).toMatchObject({ case: 'approved_voided', reason: null });

    const effective = await x.createdRetire(x.employee.id, retireBody('2026-10-05', 'direct'));
    expect((await remove(effective.id)).status).toBe(200);
    expect(await x.cancellationOf(effective.id)).toMatchObject({ case: 'record_deleted_reinstated', reason: null });

    const draft = await x.createdRetire(x.employee.id, retireBody('2026-10-20', 'application'));
    expect((await remove(draft.id)).status).toBe(200);
    expect(await x.cancellationOf(draft.id)).toMatchObject({ case: 'process_voided', reason: null });
  });

  it('不提供修改撤销原因的入口：PATCH retirements/cancellations/:id → 404', async () => {
    const x = await world('f351-no-edit');
    const retire = await x.directRetire('2026-10-25');
    const result = await x.retireCancelled(retire.id);
    const patched = await x.session.request('PATCH', `/retirements/cancellations/${result.cancellation.id}`, {
      ifMatch: result.cancellation.revision,
      body: { reason: '补写' },
    });
    expect(patched.status).toBe(404);
    expect(await x.cancellationOf(retire.id)).toMatchObject({ reason: null, revision: 1 });
  });

  it('撤销离职不变：缺原因仍 400 EXIT_CANCEL_REASON_REQUIRED，原因可修改', async () => {
    const x = await world('f351-leave-unchanged');
    const leave = await x.directLeave('2026-10-25');
    expect(await x.reason(await x.cancel(leave.id, {}))).toMatchObject({
      status: 400,
      reason: 'EXIT_CANCEL_REASON_REQUIRED',
    });
    const result = await x.cancelled(leave.id, { reason: '离职原因' });
    const patched = await x.session.request('PATCH', `/exits/cancellations/${result.cancellation.id}`, {
      ifMatch: result.cancellation.revision,
      body: { reason: '新原因' },
    });
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect(await x.cancellationOf(leave.id)).toMatchObject({ reason: '新原因', revision: 2 });
  });
});
