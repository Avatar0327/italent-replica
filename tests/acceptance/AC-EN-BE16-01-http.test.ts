import { randomUUID } from 'node:crypto';
import {
  auditEvents,
  commandLedger,
  employmentOutbox,
  eq,
  onboardingEntryCases,
  sql,
  type Db,
  withTenant,
} from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { runEmploymentActivations } from '../../apps/api/src/modules/employment/activation-scheduler.js';
import { addPending, businessRevision, entryAction, entryWorld, hireBody } from './AC-EN-BE2a-support.js';
import { withLoginEmail } from './AC-EMP-support.js';
import { syncWorld } from './AC-OF-BE14b2-support.js';
import { edited } from './AC-OF-BE14b3-support.js';

const testDb = useTestDb();
const cases = (db: Db, tenant: string) => withTenant(db, tenant, (tx) => tx.select().from(onboardingEntryCases));

it('AC-EN-BE16-01 待入职 HTTP 生命周期保持同一阶段，拒绝旧业务 ID', async () => {
  const { db } = testDb();
  const w = await entryWorld(db, 'ZZ_BE16_HTTP');
  const first = await addPending(w, '2026-09-15', 'ZZ_BE16_HTTP');
  const all = () => cases(db, w.session.tenant.id);
  const [initial] = await all();
  expect(initial).toMatchObject({
    rootBusinessId: first.recordId,
    currentBusinessId: first.recordId,
    pendingDate: '2026-09-15',
    state: 'pending',
  });

  expect((await entryAction(w, first.recordId, 'cancel', {})).status).toBe(200);
  expect(await all()).toMatchObject([{ id: initial!.id, state: 'cancelled' }]);
  const edit = await w.session.request('PATCH', `/pending-entries/${first.recordId}`, {
    ifMatch: await businessRevision(w, first.recordId),
    body: { effectiveDate: '2026-09-16', probation: false },
  });
  expect(edit.status, await edit.clone().text()).toBe(200);
  const { id: editedId } = (await edit.json()) as { id: string };
  expect(await all()).toMatchObject([{ id: initial!.id, currentBusinessId: editedId, state: 'cancelled' }]);
  expect((await entryAction(w, first.recordId, 'cancel', {}, first.business.revision)).status).toBe(409);

  const restore = await entryAction(w, editedId, 'postpone', { effectiveDate: '2026-09-17' });
  expect(restore.status, await restore.clone().text()).toBe(200);
  const { id: latest } = (await restore.json()) as { id: string };
  expect(await all()).toMatchObject([
    {
      id: initial!.id,
      rootBusinessId: first.recordId,
      currentBusinessId: latest,
      pendingDate: '2026-09-17',
      state: 'pending',
    },
  ]);
  expect((await entryAction(w, latest, 'complete', { probation: false })).status).toBe(200);
  expect(await all()).toMatchObject([
    {
      id: initial!.id,
      state: 'hired',
      hiredRecordId: latest,
      hiredOn: '2026-09-17',
      revision: 5,
    },
  ]);
  const other = await addPending(w, '2026-09-22', 'ZZ_BE16_DELETE');
  const removed = await w.session.request('DELETE', `/businesses/${other.recordId}`, {
    ifMatch: other.business.revision,
    body: {},
  });
  expect(removed.status, await removed.clone().text()).toBe(200);
  expect((await all()).find((row) => row.rootBusinessId === other.recordId)).toMatchObject({ state: 'deleted' });
});

it('AC-EN-BE16-01 / OF-10 Offer 同步、显式推送、拒绝和失效共用阶段，手工改期不回写日期', async () => {
  const { db } = testDb();
  const w = await syncWorld(db, 'ZZ_BE16_OFFER');
  const offer = await w.accepted(await w.social({ name: 'ZZ_BE16_OFFER' }));
  const first = (await w.entryOf(offer)).id;
  const all = () => cases(db, w.tenant.id);
  const [initial] = await all();
  expect(initial).toMatchObject({ rootBusinessId: first, currentBusinessId: first, state: 'pending' });
  const pushed = await edited(w, offer, { plannedEntryDate: '2026-11-15', syncPendingEntry: true });
  expect(pushed.entrySync).toBe('pushed');
  const current = (await w.entryOf(pushed)).id;
  expect(current).not.toBe(first);
  expect(await all()).toMatchObject([{ id: initial!.id, currentBusinessId: current, pendingDate: '2026-11-15' }]);

  const postponed = await w.entryAction(current, 'postpone', { effectiveDate: '2026-11-20' });
  expect(postponed.status, await postponed.clone().text()).toBe(200);
  expect((await w.read(offer.id)).plannedEntryDate).toBe('2026-11-15');
  const rejected = await w.moved(await w.read(offer.id), {
    target: 'rejected',
    refusalTime: '2026-10-18',
    refusalReasonCode: 'personal',
  });
  expect(rejected.status).toBe('rejected');
  expect(await all()).toMatchObject([{ id: initial!.id, state: 'cancelled', pendingDate: '2026-11-20' }]);

  const second = await w.accepted(await w.social({ name: 'ZZ_BE16_INVALIDATE' }));
  const invalidated = await w.request('POST', `/${second.id}/invalidate`, {
    ifMatch: second.revision,
    body: { reasonCode: 'candidate_gave_up' },
  });
  expect(invalidated.status, await invalidated.clone().text()).toBe(200);
  expect((await all()).find((row) => row.rootBusinessId === second.pendingEntryBusinessId)).toMatchObject({
    state: 'deleted',
  });
  const created = await withTenant(db, w.tenant.id, (tx) =>
    tx.select().from(auditEvents).where(eq(auditEvents.action, 'onboarding.entry_case.create')),
  );
  expect(created).toHaveLength(2);
});

it('AC-EN-BE16-01 提前办理后只在租户入职日由既有调度收口，重跑维持一个阶段', async () => {
  const { db } = testDb();
  const w = await entryWorld(db, 'ZZ_BE16_DUE');
  const { recordId } = await addPending(w, '2026-10-03', 'ZZ_BE16_DUE');
  expect((await entryAction(w, recordId, 'complete', { probation: false })).status).toBe(200);
  const all = () => cases(db, w.session.tenant.id);
  expect(await all()).toMatchObject([{ state: 'pending', hiredRecordId: null, revision: 1 }]);
  const sweep = async (iso: string) =>
    runEmploymentActivations(
      db,
      { actorUserId: null, commandId: randomUUID() },
      { tenantId: w.session.tenant.id },
      { clock: () => new Date(iso) },
    );
  expect((await sweep('2026-10-02T15:59:00Z')).runs[0]?.errors).toEqual([]);
  expect(await all()).toMatchObject([{ state: 'pending' }]);
  expect((await sweep('2026-10-02T16:00:00Z')).runs[0]?.errors).toEqual([]);
  expect((await sweep('2026-10-03T17:00:00Z')).runs[0]?.errors).toEqual([]);
  expect(await all()).toMatchObject([{ state: 'hired', hiredRecordId: recordId, hiredOn: '2026-10-03', revision: 2 }]);
});

it('AC-EN-BE16-02 保存后写台账失败，阶段、审计和 outbox 同事务回滚', async () => {
  const { db } = testDb();
  const w = await entryWorld(db, 'ZZ_BE16_SAVE_ROLLBACK');
  const employee = await w.session.employee('ZZ_BE16_SAVE_ROLLBACK');
  const commandId = randomUUID();
  await db.execute(sql`
    CREATE FUNCTION zz_be16_fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'ZZ_BE16_SAVE_ROLLBACK' USING ERRCODE = '53100';
    END;
    $$
  `);
  await db.execute(sql`
    CREATE TRIGGER zz_be16_fail_ledger BEFORE INSERT ON command_ledger FOR EACH ROW
    WHEN (NEW.command_id = ${sql.raw(`'${commandId}'`)}) EXECUTE FUNCTION zz_be16_fail_ledger()
  `);
  const created = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: employee.revision,
    idempotencyKey: commandId,
    body: withLoginEmail(employee.id, hireBody(w.org.id, '2026-10-10', { pendingEntry: true })),
  });
  expect(created.status, await created.clone().text()).toBe(503);
  expect(await created.json()).toMatchObject({ error: { details: { reason: 'STORAGE_UNWRITABLE' } } });
  expect(await cases(db, w.session.tenant.id)).toEqual([]);
  await withTenant(db, w.session.tenant.id, async (tx) => {
    expect(await tx.select().from(commandLedger).where(eq(commandLedger.commandId, commandId))).toEqual([]);
    expect(await tx.select().from(auditEvents).where(eq(auditEvents.commandId, commandId))).toEqual([]);
    expect(await tx.select().from(employmentOutbox).where(eq(employmentOutbox.employeeId, employee.id))).toEqual([]);
  });
});
