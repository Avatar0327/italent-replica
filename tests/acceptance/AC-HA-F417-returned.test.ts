import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { offerApprovalWorld, type OfferView } from './AC-OF-BE14a3-support.js';
import { processClient } from './AC-HA-13c-support.js';

const database = useTestDb();
it('F-417④：单份和批量 Offer 驳回及随后直接发送均不计在途，重提恢复在途', async () => {
  const w = await offerApprovalWorld(database().db, 'f417-returned');
  const now = '2026-10-20T01:00:00.000Z';
  w.setNow(now);
  const single = await w.offer(w.applicant);
  await w.json(await w.submitRaw(single));
  const one = await w.instance(single.id);
  const batched = await w.offer(w.applicant);
  const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [batched.id] }), 201);
  const many = await w.instance(batch.id);
  const board = processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: () => new Date(now) });
  const all = [one.id, many.id];
  await board.expectComponent('inFlightCount', { all, hits: all });
  await w.decide(one, w.head, 'reject');
  await w.decide(many, w.manager, 'reject');
  expect((await w.instance(single.id)).status).toBe('returned');
  expect((await w.instance(batch.id)).status).toBe('returned');
  await board.expectComponent('inFlightCount', { all, hits: [] });
  expect(await board.detail('inFlightList')).toEqual([]);
  for (const target of [single, batched]) {
    const current = await w.get(target.id);
    await w.json<OfferView>(
      await w.request(w.applicant.userId, 'POST', `/api/tenant/offers/${target.id}/send`, {
        ifMatch: current.revision,
        body: {},
      }),
    );
  }
  await board.expectComponent('inFlightCount', { all, hits: [] });
  await board.expectComponent('offerApprovalRate', { all: [single.id, batched.id], hits: [] });
  const retry = await w.offer(w.applicant);
  await w.json(await w.submitRaw(retry));
  await w.decide(await w.instance(retry.id), w.head, 'reject');
  await w.json(await w.submitRaw(await w.get(retry.id)));
  const resumed = await w.instance(retry.id);
  expect(resumed.status).toBe('running');
  const active = await board.detail('inFlightCount', '', { hit: true });
  expect(active.map((item) => item.id)).toEqual([resumed.id]);
});
