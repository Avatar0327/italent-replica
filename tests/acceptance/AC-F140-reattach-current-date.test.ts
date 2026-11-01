import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { cancelWorld } from './AC-EXIT-cancel-support.js';

/**
 * F-140b2 P2-1 原场景是“摘下的 T 随改期挂回、到期顺延、再次摘挂”。DEC-725③（取代 DEC-263②）后，
 * 晚于最后工作日的已落地调动在离职生效时直接作废（墓碑），之后的改期、替换、撤销都不得再把它挂回或执行。
 */
const database = useTestDb();
it.each(['reposition', 'replace', 'cancel'])(
  'F-140b2 P2-1 / DEC-725③：离职生效作废的 T，%s 后仍作废、不挂回、到期不执行',
  async (operation) => {
    const x = await cancelWorld(database().db, 'f140-current-date');
    const transfer = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-15');
    expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [leave.id] });
    expect(await x.stateOfBusiness(transfer.id)).toBe('voided');
    x.setNow('2026-11-05T02:00:00Z');
    async function patch(date: string) {
      const response = await x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: (await x.business(leave.id)).revision,
        body: { lastWorkDate: date },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await patch('2026-11-04');
    expect(await x.runScheduler('2026-11-05T02:00:00Z')).not.toMatchObject({ activated: [transfer.id] });
    expect((await x.business(transfer.id)).effectiveDate).toBe('2026-10-25');
    await patch('2026-10-29');
    const response =
      operation === 'cancel'
        ? await x.cancel(leave.id)
        : await x.session.request('PATCH', `/exits/${leave.id}`, {
            ifMatch: (await x.business(leave.id)).revision,
            body: { lastWorkDate: operation === 'replace' ? '2026-11-20' : '2026-11-04' },
          });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await x.timeline()).filter((r) => r.record_id === transfer.id)).toEqual([]);
    expect(await x.stateOfBusiness(transfer.id)).toBe('voided');
    expect(await x.tombstoned(transfer.id)).toBe(true);
    const detached = (await x.effects(leave.id)).filter((r) => r.kind === 'future_transfer_detached');
    expect(detached).toHaveLength(1);
  },
);
