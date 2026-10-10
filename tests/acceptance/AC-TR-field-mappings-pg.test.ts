/**
 * R3-T04 PR-B2 字段映射与字段删除的并发（真 PG 交错；设计 §2.2 field_mappings、AGENTS §10）：
 * 映射新建先共享锁住来源 / 目标字段行，字段删除先 FOR UPDATE——二者串行，不会出现映射指向已删字段或字段被引用却被删。
 * 用外部事务持锁制造确定的先后顺序（两种先后的映射新建都是真实请求），再核对结果与落库状态。
 */
import { sql, talentReviewFieldMappings, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as configKit from '../../apps/api/src/modules/talent-review/config-kit.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { mappingBody, scoringWorld } from './AC-TR-scoring-support.js';
import { errorCode } from './support/tenant-api.js';

const database = useTestDb();
afterEach(() => vi.restoreAllMocks());
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForFieldLock(db: Db) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const rows = rowsOf<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%talent_review_fields%'`),
    );
    if (rows[0]!.n > 0) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('请求没有等到字段行锁');
}
const mappingRows = async (db: Db, tenant: string) =>
  withTenant(db, tenant, (tx) => tx.select().from(talentReviewFieldMappings));

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('AC-TR-field-mappings-pg 映射 × 字段删除交错（真 PG）', () => {
  it('字段删除先提交：等待中的映射新建得到 404，不落库', async () => {
    const db = database().db;
    const w = await scoringWorld(db, 'trm-pg-delete-first');
    const a = await w.field();
    const b = await w.field();
    const tenant = w.as.tenant;
    let pending!: Promise<Response>;
    await withTenant(db, tenant, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id = ${a.id} FOR UPDATE`);
      pending = w.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, b.id) });
      await waitForFieldLock(db);
      await tx.execute(sql`DELETE FROM talent_review_fields WHERE id = ${a.id}`);
    });
    const response = await pending;
    expect([response.status, await errorCode(response)]).toEqual([404, 'NOT_FOUND']);
    expect(await mappingRows(db, tenant)).toEqual([]);
  });

  it('映射先提交：映射新建事务停在提交前时，字段删除被挡住，映射提交后得到 409 FIELD_IN_USE（两个都是真实请求）', async () => {
    const db = database().db;
    const w = await scoringWorld(db, 'trm-pg-mapping-first');
    const a = await w.field();
    const b = await w.field();
    const tenant = w.as.tenant;
    const reached = signal();
    const release = signal();
    const original = configKit.auditConfig;
    // 映射新建事务已共享锁住来源 / 目标字段、写入映射，停在审计写入处（事务未提交）
    vi.spyOn(configKit, 'auditConfig').mockImplementationOnce(async (...args) => {
      reached.resolve();
      await release.promise;
      return original(...args);
    });
    const creating = w.request('POST', '/field-mappings', { ifMatch: 0, body: mappingBody(a.id, b.id) });
    await reached.promise;
    const deleting = w.request('DELETE', `/fields/${a.id}`, { ifMatch: 1 });
    await waitForFieldLock(db);
    release.resolve();
    const created = await creating;
    expect(created.status, await created.clone().text()).toBe(201);
    const response = await deleting;
    const body = (await response.json()) as { error: { code: string; details: { reason: string } } };
    expect([response.status, body.error.code, body.error.details.reason]).toEqual([409, 'CONFLICT', 'FIELD_IN_USE']);
    expect(await mappingRows(db, tenant)).toHaveLength(1);
    expect((await w.request('GET', `/fields/${a.id}`)).status).toBe(200);
  });
});
