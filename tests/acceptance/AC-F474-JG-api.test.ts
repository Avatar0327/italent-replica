import { randomUUID } from 'node:crypto';
import { sql, withTenant, grantMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cmd, seedTenantWithMember } from './support/tenant-api.js';
import { GRAPH, graphWorld, graphInput, record } from './support/job-graph.js';

const testDb = useTestDb();
const rows = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows);

describe('AC-F474-JG 后端快照', () => {
  it('01/05/10 GET 不生成，同步 POST 保存，缓存保持，revision 与命令重放，审计只含摘要', async () => {
    const w = await graphWorld(testDb().db);
    const get = () => w.api.request('GET', GRAPH, w.as);
    expect(await (await get()).json()).toEqual({ snapshot: null });
    const key = randomUUID();
    const first = await w.rebuild(0, key);
    expect(first.status, await first.clone().text()).toBe(200);
    const snapshot = await first.json();
    expect(snapshot).toMatchObject({ revision: 1, asOfDate: '2026-11-11', empty: false, issueCount: 0 });
    expect(first.headers.get('etag')).toBe('"1"');
    expect(await (await get()).json()).toEqual({ snapshot });
    expect(await (await w.rebuild(0, key)).json()).toEqual(snapshot);
    expect((await w.rebuild(1, key)).status).toBe(409);
    expect((await w.rebuild(0)).status).toBe(409);
    expect(await (await w.rebuild(1)).json()).toMatchObject({ revision: 2 });
    await withTenant(testDb().db, w.tenant.id, async (tx) => {
      const audits = rows(
        await tx.execute(sql`SELECT before, after FROM audit_events WHERE action='job.graph.rebuild'`),
      );
      expect(audits).toHaveLength(2);
      expect(audits[1]).toMatchObject({ before: { revision: 1 }, after: { revision: 2, issueCount: 0 } });
      expect(JSON.stringify(audits)).not.toContain('layout');
      expect(rows(await tx.execute(sql`SELECT id FROM employment_outbox WHERE event_type LIKE 'job.graph.%'`))).toEqual(
        [],
      );
    });
  });
  it('03/04/09 原因保存、15 条分页、类型和名称筛选、空图谱仍有快照', async () => {
    const input = graphInput();
    input.posts = Array.from({ length: 18 }, (_, i) => record(`bad${i}`, { name: `异常职务${i}` }));
    const w = await graphWorld(testDb().db, input);
    const generated = await w.rebuild();
    expect(generated.status, await generated.clone().text()).toBe(200);
    expect(await generated.json()).toMatchObject({ empty: true, containsError: true, issueCount: 18 });
    const list = async (query = '') => {
      const response = await w.api.request('GET', `${GRAPH}/issues${query}`, w.as);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await list()).toMatchObject({ total: 18, page: 1, pageSize: 15 });
    expect((await list()).items).toHaveLength(15);
    expect((await list('?page=2')).items).toHaveLength(3);
    expect(await list('?kind=level')).toMatchObject({ total: 0, items: [] });
    expect(await list('?kind=post&name=异常职务17')).toMatchObject({
      total: 1,
      items: [
        {
          kind: 'post',
          objectName: '异常职务17',
          reasons: [
            { code: 'POST_LEVEL_RANGE_EMPTY', params: [] },
            { code: 'POST_SEQUENCE_EMPTY', params: [] },
          ],
        },
      ],
    });
    for (const query of ['?page=0', '?pageSize=101', '?kind=other', '?page=x'])
      expect((await w.api.request('GET', `${GRAPH}/issues${query}`, w.as)).status).toBe(400);
  });
  it('05/10 写快照失败时整体回滚，旧快照与原因保持，失败不写成功审计', async () => {
    const db = testDb().db;
    const w = await graphWorld(db);
    expect((await w.rebuild()).status).toBe(200);
    const before = await (await w.api.request('GET', GRAPH, w.as)).json();
    await withTenant(db, w.tenant.id, (tx) =>
      tx.execute(sql`CREATE FUNCTION reject_job_graph_test() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$;
      CREATE TRIGGER reject_graph BEFORE UPDATE ON job_graph_snapshots
      FOR EACH ROW EXECUTE FUNCTION reject_job_graph_test();`),
    );
    try {
      expect((await w.rebuild(1)).status).toBe(503);
      expect(await (await w.api.request('GET', GRAPH, w.as)).json()).toEqual(before);
      await withTenant(db, w.tenant.id, async (tx) => {
        expect(rows(await tx.execute(sql`SELECT id FROM audit_events WHERE action='job.graph.rebuild'`))).toHaveLength(
          1,
        );
        expect(rows(await tx.execute(sql`SELECT id FROM job_graph_issues`))).toEqual([]);
      });
    } finally {
      await withTenant(db, w.tenant.id, (tx) =>
        tx.execute(sql`DROP TRIGGER reject_graph ON job_graph_snapshots;
        DROP FUNCTION reject_job_graph_test();`),
      );
    }
    expect((await w.rebuild(1)).status).toBe(200);
  });
  it('07 同一用户另一租户无快照无原因，生成后互不影响，RLS 不能跨租户读写', async () => {
    const db = testDb().db;
    const input = graphInput();
    input.posts.push(record('bad'));
    const a = await graphWorld(db, input);
    expect((await a.rebuild()).status).toBe(200);
    const b = await seedTenantWithMember(db, 'graph-b');
    await grantMembership(db, { tenantId: b.tenant.id, userId: a.user.id, expectedRevision: 0 }, cmd());
    const who = { ...a.as, tenant: b.tenant.id };
    expect(await (await a.api.request('GET', GRAPH, who)).json()).toEqual({ snapshot: null });
    expect(await (await a.api.request('GET', `${GRAPH}/issues`, who)).json()).toMatchObject({ items: [], total: 0 });
    expect((await a.api.request('POST', `${GRAPH}/rebuild`, { ...who, ifMatch: 0, body: {} })).status).toBe(200);
    expect(await (await a.api.request('GET', GRAPH, a.as)).json()).toMatchObject({
      snapshot: { revision: 1, issueCount: 1 },
    });
    await withTenant(db, b.tenant.id, async (tx) => {
      expect(rows(await tx.execute(sql`SELECT * FROM job_graph_snapshots WHERE tenant_id=${a.tenant.id}`))).toEqual([]);
      expect(rows(await tx.execute(sql`SELECT * FROM job_graph_issues WHERE tenant_id=${a.tenant.id}`))).toEqual([]);
    });
    await expect(
      withTenant(db, b.tenant.id, (tx) =>
        tx.execute(sql`INSERT INTO job_graph_issues
      (tenant_id,kind,object_id,object_name,reasons,sort_key)
      VALUES (${a.tenant.id},'post',${randomUUID()},'合成','[{"code":"x"}]',0)`),
      ),
    ).rejects.toThrow();
  });
  it('05 请求缺少 revision / 命令键、非空 body 都拒绝', async () => {
    const w = await graphWorld(testDb().db);
    expect((await w.api.request('POST', `${GRAPH}/rebuild`, { ...w.as, body: {} })).status).toBe(400);
    expect(
      (await w.api.request('POST', `${GRAPH}/rebuild`, { ...w.as, ifMatch: 0, idempotencyKey: null, body: {} })).status,
    ).toBe(400);
    expect(
      (await w.api.request('POST', `${GRAPH}/rebuild`, { ...w.as, ifMatch: 0, body: { asOf: '2020-01-01' } })).status,
    ).toBe(400);
  });
});
