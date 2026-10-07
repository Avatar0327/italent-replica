/** F-021 依赖最终引用；后续有效传播改变引用时，旧自动同步不能成为独立人工输入。 */
import { runEmploymentActivations } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { versions, worker } from './AC-JOB-sequence-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { executeTransfers, manualCorrection, originalPayloads, timelineWorld } from './AC-ORG-32-timeline-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
it.each([false, true])('AC-ORG-37 同步先匹配、后被有效来源改引用，应重算序列 / 人工对照=%s', async (manual) => {
  const s = await timelineWorld(database().db, `r6syncFinalReference${manual}`, true);
  const postD = await s.w.job('posts', '有效职务 D', { sequenceId: s.sequenceA.id });
  const first = await s.w.business(
    s.person.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { place: '迟到地点' } },
    (await s.w.getEmployee(s.person.id)).revision,
  );
  const adjustment = await s.w.business(
    s.person.id,
    {
      kind: 'org_adjustment',
      mode: 'direct',
      effectiveDate: '2026-10-09',
      fields: { postId: s.postB.id },
    },
    (await s.w.getEmployee(s.person.id)).revision,
  );
  const now = new Date('2026-10-10T01:00:00Z');
  const api = tenantApi(s.db, { clock: () => now });
  const changed = await api.request('PATCH', `/api/tenant/job/posts/${s.postB.id}`, {
    user: s.w.user.id,
    tenant: s.w.tenant.id,
    ifMatch: s.postB.revision,
    body: { sequenceId: s.sequenceC.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  expect(await worker(s.db, s.w.tenant.id, undefined, { clock: () => now })).toMatchObject({
    completed: 1,
    failed: 0,
  });
  expect((await s.w.record(adjustment.id, '2026-10-09')).fields.sequenceId).toBe(s.sequenceC.id);
  // 执行同步时前驱已经是历史，不参与 F-021；后补有效调动的序列值匹配不能覆盖 C / 人工 X。
  expect((await s.w.record(first.id, '2026-10-05')).fields.sequenceId).toBe(s.sequenceB.id);
  if (manual) await manualCorrection(s, adjustment.id);
  s.w.setNow(now.toISOString());
  const effectiveSource = await s.w.business(
    s.person.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-10-06',
      fields: { postId: postD.id, sequenceId: s.sequenceA.id },
    },
    (await s.w.getEmployee(s.person.id)).revision,
  );
  const before = await s.w.record(adjustment.id, '2026-10-09');
  expect(before.fields).toMatchObject({
    postId: postD.id,
    sequenceId: manual ? s.sequenceX.id : s.sequenceC.id,
  });
  const [forward] = await withTenant(s.db, s.w.tenant.id, async (tx) =>
    resultRows<{ after: Record<string, unknown> }>(
      await tx.execute(sql`SELECT payload->'after' AS after FROM employment_outbox
        WHERE tenant_id=${s.w.tenant.id} AND business_id=${adjustment.id}::uuid
          AND event_type='employment.forward-update'
          AND payload_version_id IN (SELECT id FROM employment_payload_versions
            WHERE tenant_id=${s.w.tenant.id} AND trigger_business_id=${effectiveSource.id}::uuid)`),
    ),
  );
  expect(forward?.after.postId).toBe(postD.id);
  expect(forward?.after).not.toHaveProperty('sequenceId');
  const originals = await originalPayloads(s);
  await executeTransfers(s, [first.id], '2026-10-12');
  expect((await s.w.record(adjustment.id, '2026-10-09')).fields).toMatchObject({
    postId: postD.id,
    sequenceId: manual ? s.sequenceX.id : s.sequenceA.id,
  });
  expect(await originalPayloads(s)).toEqual(originals);
  const after = await versions(s.db, s.w.tenant.id, s.person.id);
  const rerun = await runEmploymentActivations(
    s.db,
    cmd(),
    { tenantId: s.w.tenant.id },
    {
      clock: () => new Date('2026-10-12T02:00:00Z'),
    },
  );
  expect(rerun.runs[0]).toMatchObject({ failed: [], errors: [] });
  expect(await versions(s.db, s.w.tenant.id, s.person.id)).toEqual(after);
});
