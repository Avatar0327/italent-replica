/** F-306：申请详情回读单据试用期三项；期望来自派发单，旧实现应判红。 */
import { sql, withTenant } from '@italent/db';
import { createTestDb } from '@italent/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { internWorld, scopedRequest, type InternWorld } from './AC-IN-BE6a-support.js';

let handle: Awaited<ReturnType<typeof createTestDb>>;
// DEC-452：本机并行工作区下完整迁移超过 60 秒，仅给本文件初始化留足时间，不放宽业务断言。
beforeAll(async () => {
  handle = await createTestDb();
}, 300_000);
afterAll(async () => handle?.close());
const testDb = () => handle;
const terms = { probation: true, probationMonths: 2, probationEndDate: '2026-12-20' };

async function draft(w: InternWorld, probation: object = terms, employeeId?: string, effectiveDate = '2026-10-20') {
  const id = employeeId ?? (await w.hire('回读验收合成实习生', 'intern')).employee.id;
  const response = await w.session.request('POST', `/employees/${id}/businesses`, {
    ifMatch: await w.revision(id),
    body: {
      kind: 'intern_regularization',
      mode: 'application',
      effectiveDate,
      fields: { departmentId: w.other.id },
      ...probation,
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const created = (await response.json()) as { id: string; revision: number };
  return { id: created.id, revision: created.revision };
}

async function read(w: InternWorld, id: string) {
  const response = await w.session.request('GET', `/businesses/${id}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Record<string, unknown> & { revision: number };
}

describe('AC-IN-F306 申请详情试用期回读', () => {
  it('创建后回读三项：使用本单持久化值，revision 与创建回执一致', async () => {
    const w = await internWorld(testDb().db, 'f306-create');
    const created = await draft(w);
    // 证明创建已实际落库，回读失败不能归因于夹具没保存；普通 PG 角色同样走 withTenant。
    const persisted = await withTenant(w.db, w.session.tenant.id, (tx) =>
      tx.execute(sql`SELECT has_probation AS probation, months AS "probationMonths",
        expected_end_date::text AS "probationEndDate" FROM employment_probation_versions
        WHERE tenant_id=${w.session.tenant.id} AND business_id=${created.id}::uuid
        ORDER BY version_no DESC LIMIT 1`),
    );
    const rows = Array.isArray(persisted) ? persisted : persisted.rows;
    expect(rows[0]).toEqual(terms);
    expect(await read(w, created.id)).toMatchObject({ ...created, ...terms });
  });

  it('无试用期明确返回 false，月数和结束日为 null', async () => {
    const w = await internWorld(testDb().db, 'f306-none');
    const created = await draft(w, { probation: false });
    expect(await read(w, created.id)).toMatchObject({
      ...created,
      probation: false,
      probationMonths: null,
      probationEndDate: null,
    });
  });

  it('草稿改期后 revision 加一，三项仍为本单已持久化的值', async () => {
    const w = await internWorld(testDb().db, 'f306-patch');
    const created = await draft(w);
    const response = await w.session.request('PATCH', `/businesses/${created.id}`, {
      ifMatch: created.revision,
      body: { effectiveDate: '2026-10-21' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await read(w, created.id)).toMatchObject({
      id: created.id,
      revision: created.revision + 1,
      effectiveDate: '2026-10-21',
      ...terms,
    });
  });

  it('草稿 PATCH 仍拒收试用期三项，400 后原单 revision 和三项均不变', async () => {
    const w = await internWorld(testDb().db, 'f306-no-write');
    const created = await draft(w);
    const before = await read(w, created.id);
    const response = await w.session.request('PATCH', `/businesses/${created.id}`, {
      ifMatch: created.revision,
      body: { probation: false },
    });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(await read(w, created.id)).toEqual(before);
    expect(before).toMatchObject(terms);
  });

  it('同一员工两张草稿按单据 ID 取值，不借用员工当前试用期或另一张草稿', async () => {
    const w = await internWorld(testDb().db, 'f306-business-id');
    const { employee } = await w.hire('多单回读合成实习生', 'intern');
    const first = await draft(w, terms, employee.id);
    const second = await draft(w, { probation: false }, employee.id);
    const current = await w.session.request('GET', `/employees/${employee.id}/probation`);
    expect(current.status, await current.clone().text()).toBe(200);
    expect(await current.json()).toMatchObject({ hasProbation: false });
    expect(await read(w, first.id)).toMatchObject({ ...first, ...terms });
    expect(await read(w, second.id)).toMatchObject({
      ...second,
      probation: false,
      probationMonths: null,
      probationEndDate: null,
    });
  });

  it('申请只填月数时回读结束日为已保存的 null，不按日期推算', async () => {
    const w = await internWorld(testDb().db, 'f306-null-end');
    const created = await draft(w, { probation: true, probationMonths: 3 });
    expect(await read(w, created.id)).toMatchObject({
      ...created,
      probation: true,
      probationMonths: 3,
      probationEndDate: null,
    });
  });

  it('本单试用期追加版本后回读最新值，不固定取创建时第一版', async () => {
    const w = await internWorld(testDb().db, 'f306-latest');
    const { employee } = await w.hire('最新版本合成实习生', 'intern');
    const created = await draft(w, terms, employee.id, '2026-09-20');
    const submitted = await w.session.request('POST', `/businesses/${created.id}/submit`, {
      ifMatch: created.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    await w.approve(created.id);
    const changed = await w.session.request('PUT', `/employees/${employee.id}/probation`, {
      ifMatch: await w.revision(employee.id),
      body: { hasProbation: true, startDate: '2026-09-20', months: 3, expectedEndDate: '2026-12-25' },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(await read(w, created.id)).toMatchObject({
      id: created.id,
      probation: true,
      probationMonths: 3,
      probationEndDate: '2026-12-25',
    });
  });

  it('当前无试用期字段查看权时三项缺席，仍可查看已授权字段', async () => {
    const w = await internWorld(testDb().db, 'f306-fields');
    const created = await draft(w);
    const request = scopedRequest(w, [w.org.id, w.other.id], ['id', 'revision', 'departmentId']);
    const response = await request('GET', `/businesses/${created.id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({ ...created, fields: { departmentId: w.other.id } });
    for (const key of Object.keys(terms)) expect(value).not.toHaveProperty(key);
    const allowed = scopedRequest(w, [w.org.id, w.other.id], ['id', 'revision', ...Object.keys(terms)]);
    const visible = await allowed('GET', `/businesses/${created.id}`);
    expect(visible.status, await visible.clone().text()).toBe(200);
    expect(await visible.json()).toMatchObject({ ...created, ...terms });
    const partial = scopedRequest(w, [w.org.id, w.other.id], ['id', 'probationMonths']);
    const partialResponse = await partial('GET', `/businesses/${created.id}`);
    expect(partialResponse.status, await partialResponse.clone().text()).toBe(200);
    const partialValue = await partialResponse.json();
    expect(partialValue).toMatchObject({ id: created.id, probationMonths: 2 });
    expect(partialValue).not.toHaveProperty('probation');
    expect(partialValue).not.toHaveProperty('probationEndDate');
    const outOfScope = scopedRequest(w, [], Object.keys(terms));
    expect((await outOfScope('GET', `/businesses/${created.id}`)).status).toBe(404);
  });

  it('提交后旧 revision 冲突及审批中明确拒绝均不改变原单回读值', async () => {
    const w = await internWorld(testDb().db, 'f306-conflict');
    const created = await draft(w);
    const submitted = await w.session.request('POST', `/businesses/${created.id}/submit`, {
      ifMatch: created.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const before = await read(w, created.id);
    const stale = await w.session.request('PATCH', `/businesses/${created.id}`, {
      ifMatch: created.revision,
      body: { effectiveDate: '2026-10-21' },
    });
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
    const refused = await w.session.request('PATCH', `/businesses/${created.id}`, {
      ifMatch: before.revision,
      body: { effectiveDate: '2026-10-21' },
    });
    expect(refused.status, await refused.clone().text()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: 'APPROVAL_IN_PROGRESS' } } });
    const after = await read(w, created.id);
    expect(after).toEqual(before);
    expect(after).toMatchObject(terms);
  });
});
