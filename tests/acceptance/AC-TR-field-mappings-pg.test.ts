/**
 * R3-T04 PR-B2 字段映射与字段删除的并发（真 PG 交错；设计 §2.2 field_mappings、AGENTS §10）：
 * 映射新建先共享锁住来源 / 目标字段行，字段删除先 FOR UPDATE——二者串行，不会出现映射指向已删字段或字段被引用却被删。
 * 用外部事务持锁制造确定的先后顺序，再核对两种先后的结果与落库状态。
 */
import { randomUUID } from 'node:crypto';
import { sql, talentReviewFieldMappings, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { mappingBody, scoringWorld } from './AC-TR-scoring-support.js';
import { errorCode } from './support/tenant-api.js';

const database = useTestDb();

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

  it('映射先提交：等待中的字段删除得到 409 FIELD_IN_USE，字段与映射都保留', async () => {
    const db = database().db;
    const w = await scoringWorld(db, 'trm-pg-mapping-first');
    const a = await w.field();
    const b = await w.field();
    const tenant = w.as.tenant;
    let pending!: Promise<Response>;
    await withTenant(db, tenant, async (tx) => {
      await tx.execute(sql`SELECT id FROM talent_review_fields WHERE id IN (${a.id}, ${b.id}) FOR SHARE`);
      pending = w.request('DELETE', `/fields/${a.id}`, { ifMatch: 1 });
      await waitForFieldLock(db);
      await tx.insert(talentReviewFieldMappings).values({
        id: randomUUID(),
        tenantId: tenant,
        scene: 'carry_last',
        sourceFieldId: a.id,
        targetFieldId: b.id,
        createdBy: w.as.user,
      });
    });
    const response = await pending;
    expect([response.status, await errorCode(response)]).toEqual([409, 'CONFLICT']);
    expect(await mappingRows(db, tenant)).toHaveLength(1);
    expect((await w.request('GET', `/fields/${a.id}`)).status).toBe(200);
  });
});
