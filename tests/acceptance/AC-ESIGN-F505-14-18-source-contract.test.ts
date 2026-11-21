import { pgErrorCode, sql, withTenant } from '@italent/db';
import { type ESignSourceEvent } from '@italent/domain';
import { testDbMode, useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { registerEntrySourceEvents } from '../../apps/api/src/modules/employment/entry-source-events.js';
import { registerOfferSourceEvents } from '../../apps/api/src/modules/offer/source-events.js';
import { addPending, entryAction, entryWorld } from './AC-EN-BE2a-support.js';
import { insertTask } from './AC-ESIGN-F505-support.js';
import { fullSocial, syncWorld } from './AC-OF-BE14b2-support.js';
import { taskFixture } from './AC-ESIGN-F505-s3-support.js';
import { settledOrBlocked, withHeldLock } from './support/pg-interleave.js';

const testDb = useTestDb();

it('改期的来源事件应在组织设置锁之后发出（真实 HTTP）', async (context) => {
  if (testDbMode() !== 'pg') context.skip();
  const { db } = testDb();
  const w = await entryWorld(db, 'ZZ_F505_lock_order');
  const { employee, recordId, business } = await addPending(w, '2026-11-01', 'ZZ_F505_lock_employee');
  const { id: tenantId } = w.session.tenant;
  const taskId = await insertTask(db, tenantId, w.session.user.id, {
    scene: 'entry',
    employeeId: employee.id,
    businessId: recordId,
    sourceRevision: business.revision,
  });
  let subscriberLockedTask = false;
  registerEntrySourceEvents('zz-f505-order-probe', async (tx, _ctx, event) => {
    if (event.sourceId !== recordId || event.change !== 'deleted') return;
    await tx.execute(sql`SELECT 1 FROM esign_tasks WHERE tenant_id=${tenantId} AND id=${taskId}::uuid FOR UPDATE`);
    subscriberLockedTask = true;
  });
  let taskLockAvailable = false;
  const response = await withHeldLock(
    {
      run: (fn) => withTenant(db, tenantId, fn),
      take: (tx) => tx.execute(sql`SELECT 1 FROM org_settings WHERE tenant_id=${tenantId} FOR UPDATE`),
    },
    async ({ track, release }) => {
      const request = track(entryAction(w, recordId, 'postpone', { effectiveDate: '2026-11-10' }, business.revision));
      expect(await settledOrBlocked(db, request, 1)).toBe('blocked');

      const sqlState = await withTenant(db, tenantId, (tx) =>
        tx.execute(sql`SELECT 1 FROM esign_tasks WHERE tenant_id=${tenantId} AND id=${taskId}::uuid FOR UPDATE NOWAIT`),
      ).then(
        () => 'ok',
        (error: unknown) => pgErrorCode(error),
      );
      taskLockAvailable = sqlState === 'ok' && !subscriberLockedTask;
      await release();
      return request;
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(taskLockAvailable, '组织设置锁尚未取得时，签署任务行须仍可取锁').toBe(true);
});

it('已接受 Offer 的立即同步切换人员绑定时应发 changed（真实 HTTP）', async () => {
  const { db } = testDb();
  const w = await syncWorld(db, 'ZZ_F505_binding');
  await w.timing({ enabled: false });
  const offer = await fullSocial(w, { name: 'ZZ_F505_candidate' });
  const intern = await w.internEmployee('ZZ_F505_original_signer');
  const linked = await w.request('POST', `/${offer.id}/link-employee`, {
    ifMatch: offer.revision,
    body: { employeeId: intern.id },
  });
  expect(linked.status, await linked.clone().text()).toBe(200);
  const accepted = await w.accepted({ id: offer.id, revision: offer.revision + 1 });
  expect(accepted).toMatchObject({ status: 'accepted', linkedEmployeeId: intern.id, pendingEntryBusinessId: null });
  const tasks = await taskFixture(db, w.tenant.id, w.user.id);
  const tasked = await tasks.seed({ offerId: offer.id }, intern.id, accepted.revision);
  const internResponse = await w.employment('GET', `/employees/${intern.id}`);
  expect(internResponse.status, await internResponse.clone().text()).toBe(200);
  const current = (await internResponse.json()) as { revision: number };
  const converted = await w.employment('POST', `/interns/${intern.id}/regularize`, {
    ifMatch: current.revision,
    body: { effectiveDate: '2026-10-24', departmentId: w.department.id, probation: false, confirmed: true },
  });
  expect(converted.status, await converted.clone().text()).toBe(201);
  const events: ESignSourceEvent[] = [];
  registerOfferSourceEvents('zz-f505-binding-probe', async (_tx, _ctx, event) => void events.push(event));
  const synced = await w.synced(accepted);
  expect(synced).toMatchObject({ status: 'accepted', syncStatus: 'success', linkedEmployeeId: intern.id });
  const entry = await w.entryOf(synced);
  expect(entry.employeeId).not.toBe(intern.id);
  expect(events, '同步产物指向不同人员，已接受 Offer 必须发布来源绑定变更').toContainEqual({
    source: 'offer',
    sourceId: offer.id,
    change: 'changed',
    revision: synced.revision,
  });
  await tasks.revoked(tasked, 'source_changed');
});
