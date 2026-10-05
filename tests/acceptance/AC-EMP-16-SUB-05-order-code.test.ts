/** F-010 / DEC-148 / 15 §12：组合名次存储、周期刷新与租户隔离。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { rows } from '../../apps/api/src/modules/personnel/store.js';

const database = useTestDb();
const clock = () => new Date('2026-10-01T01:00:00Z');
type Rule = { field: string; direction: string; enabled: boolean };
const rule = (field: string, direction = 'asc', enabled = true): Rule => ({ field, direction, enabled });
type Item = { id: string; orderCode: number | null; code: string };
async function world(label: string) {
  const db = database().db;
  const w = await employmentSession(db, label);
  const api = tenantApi(db, { clock });
  const as = { user: w.user.id, tenant: w.tenant.id };
  const request = (method: string, path: string, body?: unknown, revision = 0, key?: string) =>
    api.request(method, `/api/tenant/personnel/${path}`, { ...as, body, ifMatch: revision, idempotencyKey: key });
  async function ok<T>(response: Response, status = 200): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(status);
    return response.json() as Promise<T>;
  }
  const configure = (items: Rule[], revision = 0, enabled = true) =>
    request('PUT', 'order-code/settings', { enabled, items }, revision).then((r) => ok(r));
  const recompute = (revision = 1, key = randomUUID()) =>
    request('POST', 'order-code/recompute', {}, revision, key).then((r) => ok(r));
  const list = async (query = '') => (await ok<{ items: Item[] }>(await request('GET', `employees${query}`))).items;
  const employee = async (code: string, fields: Record<string, unknown> = {}) => {
    const e = await w.employee(code, code);
    await w.business(e.id, { kind: 'hire', mode: 'direct', effectiveDate: '2020-01-01', fields }, 1);
    return e.id;
  };
  const post = async (code: string) =>
    ok<{ id: string }>(
      await api.request('POST', '/api/tenant/job/posts', {
        ...as,
        ifMatch: 0,
        body: { name: code, code, startDate: '2020-01-01' },
      }),
      201,
    );
  return { ...w, db, as, api, request, ok, configure, recompute, list, employee, post };
}

describe('AC-EMP-16 / AC-SUB-05 人员组合排序编码', () => {
  it('部门优先、职务次之；并列用竞争名次 1/1/3，列表和详情读取存储值', async () => {
    const w = await world('oc-rank');
    const a = await w.org('部门甲', {
      establishedOn: '2020-01-01',
      parents: { admin: { parentId: w.tenant.id, sequence: 1 } },
    });
    const b = await w.org('部门乙', {
      establishedOn: '2020-01-01',
      parents: { admin: { parentId: w.tenant.id, sequence: 2 } },
    });
    const p1 = await w.post('P1');
    const p2 = await w.post('P2');
    const e3 = await w.employee('A', { departmentId: b.id, postId: p1.id });
    const e1 = await w.employee('C', { departmentId: a.id, postId: p2.id });
    const e2 = await w.employee('B', { departmentId: a.id, postId: p2.id });
    await w.configure([rule('department'), rule('post'), rule('code', 'asc', false)]);
    await w.recompute();
    expect((await w.list()).map((r) => [r.id, r.orderCode])).toEqual([
      [e2, 1],
      [e1, 1],
      [e3, 3],
    ]);
    expect((await w.ok<Item>(await w.request('GET', `employees/${e1}`))).orderCode).toBe(1);
    for (const id of [e1, e2, e3]) {
      await w.ok(await w.request('POST', `employees/${id}/subsets/education`, { school: '合成学校' }), 201);
    }
    const subsets = await w.ok<{ items: { employeeId: string; orderCode: number }[] }>(
      await w.request('GET', 'subsets/education?sortBy=orderCode'),
    );
    expect(subsets.items.map((s) => [s.employeeId, s.orderCode])).toEqual([
      [e2, 1],
      [e1, 1],
      [e3, 3],
    ]);
  });

  it('规则顺序、方向和启用变化仅在重算后生效；同键重放与重复重算幂等', async () => {
    const w = await world('oc-config');
    const p1 = await w.post('P1');
    const p2 = await w.post('P2');
    const a = await w.employee('A', { postId: p2.id });
    const b = await w.employee('B', { postId: p1.id });
    await w.configure([rule('post'), rule('code')]);
    const key = randomUUID();
    const result = await w.recompute(1, key);
    expect(await w.recompute(1, key)).toEqual(result);
    const snapshot = await w.list();
    expect(snapshot.map((r) => r.id)).toEqual([b, a]);
    await w.recompute();
    expect(await w.list()).toEqual(snapshot);
    await w.configure([rule('code'), rule('post')], 1);
    expect(await w.list()).toEqual(snapshot);
    await w.recompute(2);
    expect((await w.list()).map((r) => r.id)).toEqual([a, b]);
    await w.configure([rule('code', 'desc'), rule('post', 'asc', false)], 2);
    await w.recompute(3);
    expect((await w.list()).map((r) => r.id)).toEqual([b, a]);
    await w.configure([rule('code')], 3, false);
    await w.recompute(4);
    expect((await w.list()).map((r) => r.orderCode)).toEqual([null, null]);
  });

  it('尚未计算按工号、ID 确定排序；缺失主职不伪造名次', async () => {
    const w = await world('oc-fallback');
    const b = await w.employee('B');
    const a = await w.employee('A');
    const pending = await w.ok<{ id: string }>(
      await w.api.request('POST', '/api/tenant/employment/employees', {
        ...w.as,
        ifMatch: 0,
        body: { name: '待入职', code: 'C' },
      }),
      201,
    );
    expect((await w.list()).map((r) => [r.id, r.orderCode])).toEqual([
      [a, null],
      [b, null],
      [pending.id, null],
    ]);
    await w.configure([rule('code', 'desc')]);
    await w.recompute();
    expect((await w.list()).map((r) => [r.id, r.orderCode])).toEqual([
      [b, 1],
      [a, 2],
      [pending.id, null],
    ]);
  });

  it.each([
    ['position', 'positions', 'positionId', 'displayOrder'],
    ['level', 'levels', 'levelId', 'level'],
    ['grade', 'grades', 'gradeId', 'grade'],
  ])('%s 使用数值字段比较（非编码、非字典序），主数据变更下次重算生效', async (field, kind, reference, numeric) => {
    const w = await world(`oc-${field}`);
    const post = await w.post('P');
    const org = await w.org('合成部门', { establishedOn: '2020-01-01' });
    const extra = kind === 'positions' ? { orgId: org.id, postId: post.id } : {};
    const job = async (code: string, value: number) =>
      w.ok<{ id: string; revision: number }>(
        await w.api.request('POST', `/api/tenant/job/${kind}`, {
          ...w.as,
          ifMatch: 0,
          body: { name: code, code, startDate: '2020-01-01', [numeric]: value, ...extra },
        }),
        201,
      );
    const low = await job('Z', 2);
    const high = await job('A', 10);
    const first = await w.employee('Z', { [reference]: low.id, postId: post.id, departmentId: org.id });
    const second = await w.employee('A', { [reference]: high.id, postId: post.id, departmentId: org.id });
    await w.configure([rule(field)]);
    await w.recompute();
    expect((await w.list()).map((r) => [r.id, r.orderCode])).toEqual([
      [first, 1],
      [second, 2],
    ]);
    await w.ok(
      await w.api.request('PATCH', `/api/tenant/job/${kind}/${low.id}`, {
        ...w.as,
        ifMatch: low.revision,
        body: { effectiveDate: '2026-10-01', [numeric]: 20 },
      }),
    );
    expect((await w.list()).map((r) => r.id)).toEqual([first, second]);
    await w.recompute();
    expect((await w.list()).map((r) => r.id)).toEqual([second, first]);
  });

  it('行政层级优先于子部门局部顺序；调整上级顺序后下一次重算才改变名次', async () => {
    const w = await world('oc-hierarchy');
    const org = (name: string, parentId: string, sequence: number) =>
      w.org(name, {
        establishedOn: '2020-01-01',
        parents: { admin: { parentId, sequence } },
      });
    const a = await org('甲', w.tenant.id, 2);
    const b = await org('乙', w.tenant.id, 10);
    const child = await org('甲下级', a.id, 99);
    const first = await w.employee('Z', { departmentId: child.id });
    const second = await w.employee('A', { departmentId: b.id });
    await w.configure([rule('department')]);
    await w.recompute();
    expect((await w.list()).map((r) => r.id)).toEqual([first, second]);
    await w.ok(
      await w.api.request('PATCH', `/api/tenant/org/organizations/${a.id}`, {
        ...w.as,
        ifMatch: a.revision,
        body: { effectiveDate: '2026-10-01', parents: { admin: { parentId: w.tenant.id, sequence: 20 } } },
      }),
    );
    expect((await w.list()).map((r) => r.id)).toEqual([first, second]);
    await w.recompute();
    expect((await w.list()).map((r) => r.id)).toEqual([second, first]);
  });

  it('重算不重复写名次、审计或 outbox；同命令 ID 异内容报冲突，非法规则整体拒绝', async () => {
    const w = await world('oc-idempotency');
    await w.employee('A');
    await w.configure([rule('code')]);
    const key = randomUUID();
    await w.recompute(1, key);
    const snapshot = () =>
      withTenant(w.db, w.tenant.id, async (tx) => {
        const data = await tx.execute(sql`SELECT
        (SELECT jsonb_agg(to_jsonb(r)) FROM personnel_employee_order_codes r) AS ranks,
        (SELECT count(*)::int FROM audit_events WHERE object_type='personnel-order-code') AS audits,
        (SELECT count(*)::int FROM personnel_outbox WHERE object_type='personnel-order-code') AS events`);
        return rows(data);
      });
    const before = await snapshot();
    await w.recompute(1, key);
    await w.recompute();
    expect(await snapshot()).toEqual(before);
    expect((await w.request('POST', 'order-code/recompute', {}, 2, key)).status).toBe(409);
    expect(
      (await w.request('PUT', 'order-code/settings', { enabled: true, items: [rule('code'), rule('code')] }, 1)).status,
    ).toBe(400);
    expect((await w.request('PUT', 'order-code/settings', { enabled: true, items: [rule('unknown')] }, 1)).status).toBe(
      400,
    );
    const denied = tenantApi(w.db, { clock, authorize: () => false });
    expect(
      (
        await denied.request('POST', '/api/tenant/personnel/order-code/recompute', {
          ...w.as,
          body: {},
          ifMatch: 1,
          idempotencyKey: key,
        })
      ).status,
    ).toBe(403);
  });

  it('RLS 隔离配置和名次，复合外键拒绝跨租户员工；手工重算无越租户入口', async () => {
    const a = await world('oc-tenant-a');
    const b = await world('oc-tenant-b');
    const ea = await a.employee('A');
    const eb = await b.employee('B');
    await a.configure([rule('code')]);
    await b.configure([rule('code', 'desc')]);
    await a.recompute();
    expect((await b.list())[0]?.orderCode).toBeNull();
    await b.recompute();
    await withTenant(a.db, a.tenant.id, async (tx) => {
      const value = await tx.execute(sql`SELECT employee_id FROM personnel_employee_order_codes`);
      const stored = rows(value);
      expect(stored).toEqual([{ employee_id: ea }]);
    });
    await expect(
      withTenant(a.db, a.tenant.id, (tx) =>
        tx.execute(sql`
      INSERT INTO personnel_employee_order_codes(tenant_id,employee_id,order_code)
      VALUES (${a.tenant.id},${eb}::uuid,99)`),
      ),
    ).rejects.toThrow();
    expect((await a.request('POST', 'order-code/recompute', { tenantId: b.tenant.id }, 1)).status).toBe(400);
    expect((await a.request('POST', 'order-code/recompute', {}, 0)).status).toBe(409);
    const denied = tenantApi(a.db, { clock, authorize: () => false });
    expect(
      (
        await denied.request('POST', '/api/tenant/personnel/order-code/recompute', {
          ...a.as,
          body: {},
          ifMatch: 1,
        })
      ).status,
    ).toBe(403);
  });
});
