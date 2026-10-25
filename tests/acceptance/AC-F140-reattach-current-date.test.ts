import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { cancelWorld } from './AC-EXIT-cancel-support.js';

const database = useTestDb();
it.each(['reposition', 'replace', 'cancel'])(
  'F-140b2 P2-1：调动顺延后再次摘挂，%s 只挂回一次且保留最新实际日',
  async (operation) => {
    const x = await cancelWorld(database().db, 'f140-current-date');
    const transfer = await x.directTransfer(x.to, '2026-10-25');
    const leave = await x.directLeave('2026-10-15');
    expect(await x.runScheduler('2026-10-16T02:00:00Z')).toMatchObject({ activated: [leave.id] });
    x.setNow('2026-11-05T02:00:00Z');
    async function patch(date: string) {
      const response = await x.session.request('PATCH', `/exits/${leave.id}`, {
        ifMatch: (await x.business(leave.id)).revision,
        body: { lastWorkDate: date },
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
    await patch('2026-11-04');
    await x.runScheduler('2026-11-05T02:00:00Z');
    expect((await x.business(transfer.id)).effectiveDate).toBe('2026-11-05');
    await patch('2026-10-29');
    const detached = (await x.effects(leave.id)).filter((r) => r.kind === 'future_transfer_detached');
    expect(detached).toHaveLength(2);
    const before = await x.timeline();
    const current = await x.business(leave.id);
    const response =
      operation === 'cancel'
        ? await x.cancel(leave.id)
        : await x.session.request('PATCH', `/exits/${leave.id}`, {
            ifMatch: current.revision,
            body: { lastWorkDate: operation === 'replace' ? '2026-11-20' : '2026-11-04' },
          });
    if (response.status !== 200) {
      expect(await x.timeline()).toEqual(before);
      expect(await x.business(leave.id)).toEqual(current);
    }
    expect(response.status, await response.clone().text()).toBe(200);
    const restored = (await x.timeline()).filter((r) => r.record_id === transfer.id);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.start_date).toBe('2026-11-05');
    const [window] = await x.sqlRows<{ empty: boolean; until: string | null }>(sql`
      SELECT isempty(valid_during) AS empty, upper(valid_during)::text AS until
      FROM employment_timeline WHERE tenant_id=${x.session.tenant.id} AND record_id=${transfer.id}::uuid`);
    expect(window).toEqual({ empty: operation === 'reposition', until: null });
  },
);
