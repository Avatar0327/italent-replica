import { routeManifest } from '@italent/api';
import { pgErrorCode, sql, withTenant } from '@italent/db';
import { testDbMode, useTestDb } from '@italent/testkit';
import { afterAll, expect, it } from 'vitest';
import { lifecycleWorld, ok, REJECT } from './AC-ESIGN-F505-s3-support.js';
import { settledOrBlocked, withHeldLock } from './support/pg-interleave.js';
import { readFrozenContract } from './support/route-policy/baseline.js';
import {
  checkRecorded,
  createRecorder,
  mergeRecorded,
  observe,
  readFrozenRecorded,
  writeFrozenRecorded,
} from './support/route-policy/recorded.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const recorder = createRecorder();
const DELETE = 'DELETE /api/tenant/offers/:id';
const CANCEL = 'POST /api/tenant/employment/pending-entries/:id/cancel';
const endpoints = new Set([DELETE, CANCEL]);

afterAll(() => {
  if (!Object.keys(recorder.facts).length) return;
  const contract = readFrozenContract();
  expect(contract).toBeDefined();
  const routes = routeManifest(tenantApi(testDb().db).app).declared;
  for (const key of endpoints) expect(contract!.routes[key], key).toBeDefined();
  const frozen = readFrozenRecorded();
  const current =
    process.env.ROUTE_POLICY_UPDATE_BASELINE === '1' ? mergeRecorded(frozen, recorder.facts, endpoints) : frozen;
  expect(
    checkRecorded({ collected: recorder.facts, frozen: current, scope: endpoints, routes, contract: contract! }),
  ).toEqual([]);
  if (current !== frozen) writeFrozenRecorded(current);
});

/** 只令写入第二条撤销通知失败。测试专库 DDL 用 app_owner，表数据仍经 withTenant。 */
async function failSecondNotice(db: ReturnType<typeof testDb>['db'], run: () => Promise<Response>) {
  await db.execute(sql`CREATE FUNCTION f505_s3_notice_fault() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'ZZ_F505 synthetic notification storage failure' USING ERRCODE='53100'; END $$`);
  await db.execute(sql`CREATE TRIGGER f505_s3_notice_fault BEFORE INSERT ON approval_notifications
    FOR EACH ROW WHEN (NEW.template_code = 'esign_revoked_initiator') EXECUTE FUNCTION f505_s3_notice_fault()`);
  try {
    return await run();
  } finally {
    await db.execute(sql`DROP TRIGGER f505_s3_notice_fault ON approval_notifications`);
    await db.execute(sql`DROP FUNCTION f505_s3_notice_fault()`);
  }
}

it.each([DELETE, CANCEL])('AC-15/18 %s 第二条撤销通知失败时撤销、来源、审计、outbox、锚点全回滚', async (endpoint) => {
  const { db } = testDb();
  const w = await lifecycleWorld(db, 'rollback');
  const { source, entry, offerTask, entryTask } = await w.pair();
  const deleting = endpoint === DELETE;
  if (deleting) {
    await ok(await w.sign(offerTask, offerTask.employeeSignerUserId!));
    await ok(await w.sign(await w.read(offerTask.id), w.user.id));
  }
  const sourceToDelete = deleting ? await w.moved(await w.moved(source, REJECT), { target: 'pending' }) : source;
  // pending 不开放发起。特意注入未撤销任务，以验证删除内核以及数据库的双重保护。
  const task = deleting ? await w.seed({ offerId: source.id }, entry.employeeId, source.revision) : entryTask;
  if (deleting) {
    await expect(
      withTenant(db, w.tenant.id, (tx) => tx.execute(sql`DELETE FROM offers WHERE id=${source.id}::uuid`)),
    ).rejects.toSatisfy((error: unknown) => pgErrorCode(error) === '55000');
  }
  const key = uniqueSuffix();
  const run = (idempotencyKey: string) =>
    deleting ? w.deleteOffer(sourceToDelete, idempotencyKey) : w.cancelEntry(entry.id, idempotencyKey);
  const audit = () =>
    w
      .query<{ action: string }>(
        sql`SELECT action FROM audit_events
    WHERE command_id=${key} ORDER BY action`,
      )
      .then((rows) => rows.map(({ action }) => action));
  const ledger = () =>
    w
      .query<{ status: number }>(
        sql`SELECT response_status AS status FROM command_ledger
    WHERE command_id=${key}`,
      )
      .then((rows) => rows.map(({ status }) => status));
  const snapshots = async () => ({
    offer: await w.readOffer(source.id),
    entry: await w.entries(),
    cancelled: await w.entries('cancelled'),
    task: await w.read(task.id),
    offerTask: await w.read(offerTask.id),
    anchor: await w.query(sql`SELECT * FROM esign_offer_sources WHERE offer_id=${source.id}::uuid`),
    outbox: await w.query(sql`SELECT event_type FROM employment_outbox WHERE command_id=${key}`),
    notices: await w.notices(task.id),
    audit: await audit(),
    ledger: await ledger(),
  });
  const before = await snapshots();
  const rejected = await failSecondNotice(db, () => run(key));
  expect(rejected.status, '第二条撤销通知写失败，来源命令必须回滚').toBe(503);
  expect(await snapshots()).toEqual(before);
  const fact = await observe(rejected, {
    audit: { before: before.audit, after: await audit() },
    ledger: { before: before.ledger, after: await ledger() },
  });
  recorder.recordFact(endpoint, 'outcome', fact);
  recorder.recordFact(endpoint, 'ledger', fact);
  recorder.recordFact(endpoint, 'fixedKeys', fact);

  await ok(await run(uniqueSuffix()));
  await w.revoked(task, deleting ? 'business_deleted' : 'source_cancelled');
  if (deleting) {
    expect((await w.request('GET', `/${source.id}`)).status).toBe(404);
    expect(await w.query(sql`SELECT deleted_at FROM esign_offer_sources WHERE offer_id=${source.id}::uuid`)).toEqual([
      { deleted_at: expect.anything() },
    ]);
  } else {
    expect((await w.entries('cancelled')).map(({ id }) => id)).toContain(entry.id);
    await w.revoked(offerTask, 'source_cancelled');
  }
});

it.each(['cancel', 'complete'] as const)('AC-18 真 PG 源取消与本人完成竞争，%s 先取任务锁', async (first, context) => {
  if (testDbMode() !== 'pg') context.skip();
  const { db } = testDb();
  const w = await lifecycleWorld(db, 'race');
  const { entry, entryTask } = await w.pair();
  await ok(await w.sign(entryTask, entryTask.employeeSignerUserId!));
  const task = await w.read(entryTask.id);
  const cancel = () => w.cancelEntry(entry.id);
  const complete = () => w.sign(task, w.user.id);
  const requests = first === 'cancel' ? [cancel, complete] : [complete, cancel];
  const { waiting, statuses } = await withHeldLock(
    {
      run: (fn) => withTenant(db, w.tenant.id, fn),
      take: (tx) => tx.execute(sql`SELECT 1 FROM esign_tasks WHERE id=${task.id}::uuid FOR UPDATE`),
    },
    async ({ track, release }) => {
      const before = track(requests[0]!());
      const beforeWait = await settledOrBlocked(db, before, 1);
      const after = track(requests[1]!());
      const afterWait = await settledOrBlocked(db, after, beforeWait === 'blocked' ? 2 : 1);
      await release();
      return { waiting: [beforeWait, afterWait], statuses: [(await before).status, (await after).status] };
    },
  );
  expect(waiting, '来源取消与本人完成都必须等待同一任务锁').toEqual(['blocked', 'blocked']);
  expect(statuses).toEqual(first === 'cancel' ? [200, 409] : [200, 200]);
  const final = await w.read(task.id);
  expect(final).toMatchObject({ status: first === 'cancel' ? 'revoked' : 'completed', revision: task.revision + 1 });
  const notices = await w.notices(task.id);
  const prefix = first === 'cancel' ? 'esign_revoked' : 'esign_completed';
  expect(notices.map(({ template }) => template)).toEqual([`${prefix}_employee`, `${prefix}_initiator`]);
  expect((await w.entries('cancelled')).map(({ id }) => id)).toContain(entry.id);
});
