/** R3-T05 B2a：#13 保存编译、#14 默认颜色（DEC-420 / D-077）、设计 §2.2 的 64KB 保存上限。 */
import { randomUUID } from 'node:crypto';
import { createApp } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { allowAll, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const BASE = '/api/tenant/succession';
const rules = {
  rows: [
    {
      rowNo: 1,
      kind: 'field',
      field: { object: 'employee', code: 'age', path: 'employee.age', kind: 'number' },
      operator: 'lt',
      values: [35],
    },
  ],
  expression: '1',
};

describe('AC-SC B2a 人员范围保存与默认颜色', () => {
  let tenantId: string;
  let userId: string;
  let api: ReturnType<typeof tenantApi>;
  beforeAll(async () => {
    const seed = await seedTenantWithMember(testDb().db, 'sc-populations');
    tenantId = seed.tenant.id;
    userId = seed.user.id;
    api = tenantApi(testDb().db);
  });
  const request = (method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, `${BASE}${path}`, { user: userId, tenant: tenantId, body, ifMatch });

  // 🟡 DEC-420 / D-077：取自测试租户当前值，未证实是北森出厂值。
  it.each([
    ['position_risk', '#7498FB'],
    ['org_health', '#F2F3F5'],
  ])('DEC-420：%s 首次配置前 GET 返回初值 %s', async (kind, color) => {
    const response = await request('GET', `/rule-settings/${kind}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ kind, defaultColor: color });
  });

  it.each([null, '', undefined])('DEC-420：默认颜色拒绝空值 %s，拒绝后保留初值', async (color) => {
    const path = '/rule-settings/org_health';
    const before = await request('GET', path);
    expect(before.status).toBe(200);
    const snapshot = await before.json();
    const revision = Number((before.headers.get('etag') ?? '').replaceAll('"', ''));
    const rejected = await request('PUT', path, { defaultColor: color }, revision);
    expect(rejected.status).toBe(400);
    expect(await (await request('GET', path)).json()).toEqual(snapshot);
  });

  it('DEC-420：hex 大小写均可保存', async () => {
    const path = '/rule-settings/position_risk';
    const before = await request('GET', path);
    expect(before.status).toBe(200);
    const revision = Number((before.headers.get('etag') ?? '').replaceAll('"', ''));
    const response = await request('PUT', path, { defaultColor: '#aAbBcC' }, revision);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(((await response.json()) as { defaultColor: string }).defaultColor.toLowerCase()).toBe('#aabbcc');
  });

  it('#13：保存 field 条件行并读回原始规则，不暴露派生公式', async () => {
    const response = await request('POST', '/populations', { code: 'YOUNG', name: '青年人才', rules }, 0);
    expect(response.status, await response.clone().text()).toBe(201);
    const saved = (await response.json()) as { id: string; rules: unknown };
    const detail = await request('GET', `/populations/${saved.id}`);
    expect(detail.status).toBe(200);
    const view = await detail.json();
    expect(view).toMatchObject({ code: 'YOUNG', name: '青年人才', rules });
    expect(view).not.toHaveProperty('compiledFormula');
    expect(view).not.toHaveProperty('compiled_formula');
  });

  it.each(['POST', 'PUT'])('设计 §2.2：%s 的 40KB 合法 JSON 不被全局 32KB 上限拦截', async (method) => {
    const app = createApp({
      db: testDb().db,
      authorize: allowAll,
      identity: { resolve: async () => userId },
    });
    const body = ' '.repeat(40 * 1024) + JSON.stringify({ code: 'BODY_LIMIT', name: '人员范围', rules });
    const suffix = method === 'PUT' ? `/${randomUUID()}` : '';
    const response = await app.request(`${BASE}/populations${suffix}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'x-tenant-id': tenantId,
        'idempotency-key': randomUUID(),
        'if-match': method === 'POST' ? '"0"' : '"1"',
      },
      body,
    });
    // PUT 的目标不存在应为 404；POST 应进入保存，二者都不能先被全局中间件以 413 拒绝。
    expect(response.status, await response.clone().text()).not.toBe(413);
    expect(response.status).toBe(method === 'POST' ? 201 : 404);
  });
});
