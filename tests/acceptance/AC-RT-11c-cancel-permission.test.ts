/**
 * R2-T04 BE-5a′ / AC-RT-11c：撤销权限分离（设计 §6 接线点 2，§3.1 同一函数）。
 * 撤销退休只认 Employment.RetireCancel，撤销离职只认 Employment.DimissionCancel，互不复用；
 * 通用 DELETE 映射、restore、修改撤销原因同样按单据 kind 取按钮；权限链：功能权 → 按钮权 → 范围（范围外 404）。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { denyButtons } from './AC-EXIT-gate-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const world = (label: string) => retirementCancelWorld(database().db, label, TODAY);

/** 同一员工不能同时有离职与退休在途：退休单落在员工甲，离职单落在员工乙。 */
async function scene(label: string) {
  const x = await world(label);
  const colleague = await x.newcomer('乙');
  const retire = await x.directRetire('2026-10-25');
  const leave = await x.directLeave('2026-10-26', undefined, colleague.id);
  return { x, retire, leave };
}

describe('AC-RT-11c 撤销权限分离', () => {
  it('只有 RetireCancel（无 DimissionCancel）：撤销退休 200，撤销离职 403 且无写入', async () => {
    const { x, retire, leave } = await scene('rt11c-retire-only');
    const hr = x.restricted(denyButtons('Employment.DimissionCancel'));
    const before = await x.stateOf(x.employee.id);

    const denied = await hr('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '撤销' },
    });
    expect(denied.status).toBe(403);
    expect(await x.stateOfBusiness(leave.id)).toBe('approved');

    const allowed = await hr('POST', `/retirements/${retire.id}/cancel`, {
      ifMatch: (await x.business(retire.id)).revision,
      body: { reason: '撤销' },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(await x.stateOfBusiness(retire.id)).toBe('voided');
    expect(await x.stateOf(x.employee.id)).not.toEqual(before);
  });

  it('只有 DimissionCancel（无 RetireCancel）：撤销退休 403，撤销离职 200', async () => {
    const { x, retire, leave } = await scene('rt11c-leave-only');
    const hr = x.restricted(denyButtons('Employment.RetireCancel'));
    const before = await x.stateOf(x.employee.id);

    const denied = await hr('POST', `/retirements/${retire.id}/cancel`, {
      ifMatch: (await x.business(retire.id)).revision,
      body: { reason: '撤销' },
    });
    expect(denied.status).toBe(403);
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect(await x.stateOfBusiness(retire.id)).toBe('approved');

    const allowed = await hr('POST', `/exits/${leave.id}/cancel`, {
      ifMatch: (await x.business(leave.id)).revision,
      body: { reason: '撤销' },
    });
    expect(allowed.status, await allowed.clone().text()).toBe(200);
  });

  it('通用 DELETE 映射同样按 kind 取按钮：无 RetireCancel 删退休 403，无 DimissionCancel 删退休放行', async () => {
    const { x, retire } = await scene('rt11c-delete');
    const send = async (api: typeof x.session.request) =>
      api('DELETE', `/businesses/${retire.id}`, {
        ifMatch: (await x.business(retire.id)).revision,
        body: { reason: '撤销' },
      });
    expect((await send(x.restricted(denyButtons('Employment.RetireCancel')))).status).toBe(403);
    expect(await x.stateOfBusiness(retire.id)).toBe('approved');
    const allowed = await send(x.restricted(denyButtons('Employment.DimissionCancel')));
    expect(allowed.status, await allowed.clone().text()).toBe(200);
    expect(await x.cancellationOf(retire.id)).toMatchObject({ case: 'approved_voided' });
  });

  it('restore 与修改撤销原因：按钮同样是 RetireCancel；范围外 404', async () => {
    const { x, retire } = await scene('rt11c-restore-patch');
    const result = await x.retireCancelled(retire.id);
    const restore = (api: typeof x.session.request) =>
      api('POST', `/retirements/${retire.id}/restore`, { ifMatch: 1, body: {} });
    const patch = (api: typeof x.session.request) =>
      api('PATCH', `/retirements/cancellations/${result.cancellation.id}`, { ifMatch: 1, body: { reason: '篡改' } });

    const noRetireCancel = x.restricted(denyButtons('Employment.RetireCancel'));
    expect((await restore(noRetireCancel)).status).toBe(403);
    expect((await patch(noRetireCancel)).status).toBe(403);
    const noDimissionCancel = x.restricted(denyButtons('Employment.DimissionCancel'));
    expect((await restore(noDimissionCancel)).status).toBe(409);
    expect((await patch(noDimissionCancel)).status).toBe(200);
    const other = await x.otherUser();
    expect((await restore(x.restricted(denyButtons(), other.id))).status).toBe(404);
    expect((await patch(x.restricted(denyButtons(), other.id))).status).toBe(404);
  });

  it('缺功能权（对象 update）→ 403；范围外 → 404；撤权后同键重放 → 403', async () => {
    const { x, retire } = await scene('rt11c-chain');
    const send = (api: typeof x.session.request, key?: string) =>
      api('POST', `/retirements/${retire.id}/cancel`, {
        ifMatch: 1,
        body: { reason: '撤销' },
        ...(key ? { idempotencyKey: key } : {}),
      });
    expect((await send(x.restricted((request) => request.action !== 'object.update'))).status).toBe(403);
    const other = await x.otherUser();
    expect((await send(x.restricted(denyButtons(), other.id))).status).toBe(404);

    const first = await x.cancelRetire(retire.id, { reason: '撤销' }, { idempotencyKey: 'rt11c-replay' });
    expect(first.status).toBe(200);
    const replay = await send(x.restricted(denyButtons('Employment.RetireCancel')), 'rt11c-replay');
    expect(replay.status).toBe(403);
  });
});
