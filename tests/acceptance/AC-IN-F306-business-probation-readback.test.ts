/** F-306：申请详情回读单据试用期三项；期望来自派发单，旧实现应判红。 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { internWorld, scopedRequest, type InternWorld } from './AC-IN-BE6a-support.js';

const testDb = useTestDb();
const terms = { probation: true, probationMonths: 2, probationEndDate: '2026-12-20' };

async function draft(w: InternWorld, probation: object = terms) {
  const { employee } = await w.hire('回读验收合成实习生', 'intern');
  const response = await w.session.request('POST', `/employees/${employee.id}/businesses`, {
    ifMatch: await w.revision(employee.id),
    body: {
      kind: 'intern_regularization',
      mode: 'application',
      effectiveDate: '2026-10-20',
      fields: { departmentId: w.other.id },
      ...probation,
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const { id, revision } = (await response.json()) as { id: string; revision: number };
  return { id, revision };
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

  it('草稿修改三项后 revision 加一，回读新值', async () => {
    const w = await internWorld(testDb().db, 'f306-patch');
    const created = await draft(w);
    const changed = { probation: true, probationMonths: 3, probationEndDate: '2027-01-20' };
    const response = await w.session.request('PATCH', `/businesses/${created.id}`, {
      ifMatch: created.revision,
      body: changed,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await read(w, created.id)).toMatchObject({
      id: created.id,
      revision: created.revision + 1,
      ...changed,
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
