/** F-010 / DEC-148 / 15 §12：组合名次存储、周期刷新与租户隔离。 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';

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
    expect((await w.list()).map((r) => [r.id, r.orderCode])).toEqual([
      [a, null],
      [b, null],
    ]);
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
      const rows = Array.isArray(value) ? value : value.rows;
      expect(rows).toEqual([{ employee_id: ea }]);
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
