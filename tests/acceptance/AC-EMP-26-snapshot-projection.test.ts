import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { transferDeferredExcept } from './AC-EMP-26-projection-support.js';
import { addPending, entryAction, entryWorld } from './AC-EN-BE2a-support.js';
import { forwardJobApi } from './AC-FWD-support.js';
import { worker } from './AC-JOB-sequence-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

async function project(db: Db, tenantId: string, businessId: string) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ version: number; snapshot: boolean; explicit: string[]; deferred: string[] }>(
      await tx.execute(sql`SELECT version_no AS version, is_record_snapshot AS snapshot,
        explicit_field_codes AS explicit, deferred_field_codes AS deferred
        FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${businessId}
        ORDER BY version_no`),
    ).map((row) => ({ ...row, deferred: row.deferred.sort() })),
  );
}

it('AC-EMP-26 DEC-972：人员状态传播的 v2 快照保留 21 项延迟来源', async () => {
  const { db } = database();
  const w = await entryWorld(db, 'f036s3-propagated-projection');
  const { session } = w;
  const settings = await session.request('PUT', '/transfers/settings', {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: false, autoPopulate: false },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  const { employee, recordId, business } = await addPending(w, '2026-09-01');
  const transfer = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01', fields: { departmentId: w.org.id } },
    business.employeeRevision,
  );
  const completion = await entryAction(w, recordId, 'complete', { probation: true });
  expect(completion.status, await completion.clone().text()).toBe(200);
  const explicit = ['preset:departmentId'];
  const deferred = transferDeferredExcept();
  expect(await project(db, session.tenant.id, transfer.id)).toEqual([
    { version: 1, snapshot: false, explicit, deferred },
    { version: 2, snapshot: true, explicit, deferred },
  ]);
});

it('AC-EMP-26 DEC-972：序列同步的 v2 快照只消去已写入的延迟字段', async () => {
  const { db } = database();
  const w = await activationWorld(db, 'f036s3-sequence-projection');
  const { session } = w;
  const settings = await session.request('PUT', '/transfers/settings', {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: false, autoPopulate: false },
  });
  expect(settings.status, await settings.clone().text()).toBe(200);
  const { employee, hire } = await w.hired();
  const jobs = forwardJobApi(db, session);
  const initial = await jobs.create('sequences');
  const replacement = await jobs.create('sequences');
  const post = await jobs.create('posts', { sequenceId: initial.id });
  const transfer = await session.business(
    employee.id,
    {
      kind: 'transfer',
      mode: 'direct',
      effectiveDate: '2026-11-01',
      fields: { departmentId: w.to.id, postId: post.id },
    },
    hire.employeeRevision,
  );
  const api = tenantApi(db, { clock: () => new Date('2026-10-05T01:00:00Z') });
  const updated = await api.request('PATCH', `/api/tenant/job/posts/${post.id}`, {
    tenant: session.tenant.id,
    user: session.user.id,
    ifMatch: 1,
    body: { sequenceId: replacement.id, effectiveDate: '2026-10-05', syncSequenceToAssignments: true },
  });
  expect(updated.status, await updated.clone().text()).toBe(200);
  await worker(db, session.tenant.id);
  const explicit = ['preset:departmentId', 'preset:postId'];
  const deferred = transferDeferredExcept('preset:postId', 'preset:sequenceId');
  expect(await project(db, session.tenant.id, transfer.id)).toEqual([
    { version: 1, snapshot: false, explicit, deferred },
    { version: 2, snapshot: true, explicit: [...explicit, 'preset:sequenceId'], deferred },
  ]);
  expect((await session.record(transfer.id, '2026-11-01')).fields.sequenceId).toBe(replacement.id);
});
