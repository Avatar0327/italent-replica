/**
 * R2-T04 BE-5b / AC-RT-14：同时返聘的互斥与撤销（设计 §4.4、§6 #6，DEC-638 A-11）。
 * ① 同时返聘 + 加黑 → 400 RETIREMENT_REHIRE_BLACKLIST_CONFLICT；通用入口不接受 reEmployed / rehire（400 RETIREMENT_REHIRE_USE_ENDPOINT）。
 * ② 已生成返聘的退休撤销 → 409 RETIREMENT_HAS_REHIRE（专用撤销入口与通用 DELETE 同一判定，在任何写之前）；
 *    先经通用 DELETE 删除返聘业务（真实路径可达）后可撤销，不级联。
 * ③ 审批通过未生效（approved）的退休撤销：不生成返聘，plain 撤销。
 */
import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { withRehire } from './AC-RT-rehire-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
async function world(label: string) {
  return withRehire(database().db, await retirementCancelWorld(database().db, label, TODAY), TODAY);
}

describe('AC-RT-14 互斥', () => {
  it('同时返聘 + 加黑 → 400 RETIREMENT_REHIRE_BLACKLIST_CONFLICT，无任何写入', async () => {
    const x = await world('rt14-blacklist');
    const before = await x.stateOf(x.employee.id);
    const response = await x.postRehire(
      x.rehireBody('2026-10-04', 'direct', x.rehirePlan(), { exit: { addToBlacklist: true } }),
    );
    expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'RETIREMENT_REHIRE_BLACKLIST_CONFLICT' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    // 对照：不返聘的加黑退休照常创建
    const plain = await x.postRehire({
      mode: 'application',
      lastWorkDate: '2026-10-20',
      exit: { addToBlacklist: true },
    });
    expect(plain.status, await plain.clone().text()).toBe(201);
  });

  it('通用入口 POST employees/:id/businesses 带 reEmployed / rehire → 400 RETIREMENT_REHIRE_USE_ENDPOINT', async () => {
    const x = await world('rt14-generic');
    const before = await x.stateOf(x.employee.id);
    for (const extra of [
      { reEmployed: true, rehire: x.rehirePlan() },
      { reEmployed: false },
      { rehire: x.rehirePlan() },
    ]) {
      const response = await x.createRetire(x.employee.id, {
        kind: 'retirement',
        mode: 'direct',
        lastWorkDate: '2026-10-04',
        fields: {},
        ...extra,
      });
      expect(await x.reason(response)).toMatchObject({ status: 400, reason: 'RETIREMENT_REHIRE_USE_ENDPOINT' });
    }
    expect(await x.stateOf(x.employee.id)).toEqual(before);
  });
});

describe('AC-RT-14 撤销已生成返聘的退休（A-11）', () => {
  async function rehired(label: string) {
    const x = await world(label);
    const retire = await x.createdRehire(x.rehireBody('2026-10-04', 'direct'));
    expect(retire.status).toBe('effective');
    const rehireId = (await x.extension(retire.id))!.rehire_business_id!;
    expect(rehireId).toBeTruthy();
    return { x, retire, rehireId };
  }

  it('专用撤销入口与通用 DELETE 都 409 RETIREMENT_HAS_REHIRE，前后读取逐项相等', async () => {
    const { x, retire } = await rehired('rt14-has-rehire');
    const before = await x.stateOf(x.employee.id);
    expect(await x.reason(await x.cancelRetire(retire.id))).toMatchObject({
      status: 409,
      reason: 'RETIREMENT_HAS_REHIRE',
    });
    const removed = await x.session.request('DELETE', `/businesses/${retire.id}`, {
      ifMatch: (await x.business(retire.id)).revision,
      body: { reason: '录入有误' },
    });
    expect(await x.reason(removed)).toMatchObject({ status: 409, reason: 'RETIREMENT_HAS_REHIRE' });
    expect(await x.stateOf(x.employee.id)).toEqual(before);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement', 'retire_rehire']);
  });

  it('先经通用 DELETE 删除返聘业务，再撤销退休成功（不级联）；时间轴回到退休前', async () => {
    const { x, retire, rehireId } = await rehired('rt14-delete-first');
    const removed = await x.session.request('DELETE', `/businesses/${rehireId}`, {
      ifMatch: (await x.business(rehireId)).revision,
    });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire', 'retirement']);
    // 删除返聘不会连带动退休；退休仍有效、扩展行仍记着当时的返聘业务
    expect((await x.business(retire.id)).status).toBe('effective');

    const cancelled = await x.retireCancelled(retire.id);
    expect(cancelled).toMatchObject({ status: 'deleted', cancellation: { stateBefore: 'effective' } });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    expect((await x.retirementDates()).actual).toBeNull();
  });

  it('审批通过未生效（approved）的同时返聘退休：撤销 plain 成功，不生成返聘', async () => {
    const x = await world('rt14-approved');
    const retire = await x.createdRehire(x.rehireBody('2026-10-20', 'direct'));
    expect(retire.status).toBe('approved');
    expect((await x.extension(retire.id))!.rehire_business_id).toBeNull();

    const cancelled = await x.retireCancelled(retire.id);

    expect(cancelled).toMatchObject({ status: 'voided', cancellation: { case: 'approved_voided' } });
    expect((await x.extension(retire.id))!.rehire_business_id).toBeNull();
    expect(await x.rehireEffects(retire.id)).toEqual([]);
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
    // 到期调度不再生效，也不会生成返聘
    expect(await x.runScheduler('2026-10-25T01:00:00Z')).toMatchObject({ activated: [] });
    expect((await x.timeline()).map((row) => row.kind)).toEqual(['hire']);
  });
});
