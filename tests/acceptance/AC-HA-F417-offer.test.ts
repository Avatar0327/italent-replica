import './support/exit-gate-enforced.js';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { offerApprovalWorld } from './AC-OF-BE14a3-support.js';
import { processClient } from './AC-HA-13c-support.js';

const database = useTestDb();
const now = '2026-10-20T01:00:00.000Z';

it('AC-HA-F417①：批量 Offer 审批通过后每份业务明细关联同一个审批实例', async () => {
  const w = await offerApprovalWorld(database().db, 'f417-batch');
  w.setNow(now);
  const a = await w.offer(w.applicant);
  const b = await w.offer(w.applicant);
  const batch = await w.json<{ id: string }>(await w.batchRaw({ offerIds: [a.id, b.id] }), 201);
  await w.decide(await w.instance(batch.id), w.manager, 'approve');
  await w.decide(await w.instance(batch.id), w.head, 'approve');
  const instance = await w.instance(batch.id);
  expect(instance.status).toBe('approved');
  const board = processClient(w.db, { tenant: w.tenant.id, user: w.hr.id }, { now: () => new Date(now) });
  await board.expectComponent('offerApprovalRate', { all: [a.id, b.id], hits: [a.id, b.id] });
  const items = await board.detail('offerApprovalRate', '', { hit: true });
  expect(
    items.map((item) => item.instanceId),
    '批量审批业务明细必须关联已通过实例',
  ).toEqual([instance.id, instance.id]);
});
