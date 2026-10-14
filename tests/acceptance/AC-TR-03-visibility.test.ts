/** B7b：项目管理 / 行政向下公开 / 共享组织；范围取用户 × TalentReview。 */
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedPermissionWorld, BASE } from './AC-PRM-support.js';
import { configOperator } from './AC-TR-config-support.js';
import { createOrg, createMou } from './AC-TC-support.js';
import { tenantApi } from './support/tenant-api.js';
import { TR_BASE, TR_NOW } from './AC-TR-support.js';
import { uniqueSuffix } from './support/unique.js';

const testDb = useTestDb();
const PATH = '/projects';
const projectBody = (ownerOrgId: string, extra: Record<string, unknown> = {}) => ({
  code: `prj_${uniqueSuffix()}`,
  name: '合成可见性项目',
  ownerOrgId,
  year: 2026,
  period: '年度',
  periodStartDate: '2026-01-01',
  periodEndDate: '2026-12-31',
  matrices: [],
  ...extra,
});

describe('AC-TR-03-visibility', () => {
  it('管理、向下公开、共享只读在分页前过滤；TenantBase 有范围不能替代 TalentReview 空范围', async () => {
    let w = await seedPermissionWorld(testDb().db);
    const setup = tenantApi(w.db, { clock: () => TR_NOW });
    const parent = await createOrg(setup, w.asAdmin, '总部');
    const child = await createOrg(setup, w.asAdmin, '下级', parent);
    const outside = await createOrg(setup, w.asAdmin, '共享来源');
    const make = async (org: string, extra: Record<string, unknown> = {}) => {
      const res = await setup.request('POST', `${TR_BASE}${PATH}`, {
        ...w.asAdmin,
        ifMatch: 0,
        body: projectBody(org, extra),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      return (await res.json()) as { id: string; revision: number; name: string };
    };
    const managed = await make(child, { downwardPublic: true });
    const down = await make(parent, { downwardPublic: true });
    const shared = await make(outside, { sharedOrgIds: [child] });
    const closed = await make(parent);
    w = { ...w, api: tenantApi(w.db, { authorize: undefined, clock: () => TR_NOW }) };
    const op = await configOperator(w, 'project');
    const mouId = await createMou(setup, w.asAdmin, [child]);
    expect(
      (
        await setup.request('PUT', `${BASE}/scopes/${op.user.id}/TenantBase`, {
          ...w.asAdmin,
          ifMatch: 0,
          body: { kind: 'mou', mouId },
        })
      ).status,
    ).toBe(200);
    expect(await (await op.request('GET', PATH)).json()).toMatchObject({ items: [], hasDataPermission: false });
    for (const p of [managed, down, shared, closed])
      expect((await op.request('GET', `${PATH}/${p.id}`)).status).toBe(404);
    expect(
      (
        await setup.request('PUT', `${BASE}/scopes/${op.user.id}/TalentReview`, {
          ...w.asAdmin,
          ifMatch: 0,
          body: { kind: 'mou', mouId },
        })
      ).status,
    ).toBe(200);
    const list = (await (await op.request('GET', `${PATH}?pageSize=100`)).json()) as {
      items: { id: string; name: string; accessLevel: string }[];
    };
    expect(list.items.map((p) => [p.id, p.accessLevel]).sort()).toEqual(
      [
        [managed.id, 'manage'],
        [down.id, 'readonly'],
        [shared.id, 'readonly'],
      ].sort(),
    );
    expect(list.items.every((p) => p.name === '合成可见性项目')).toBe(true);
    expect((await op.request('GET', `${PATH}/${closed.id}`)).status).toBe(404);
    for (const [p, accessLevel] of [
      [managed, 'manage'],
      [down, 'readonly'],
      [shared, 'readonly'],
    ] as const) {
      expect(await (await op.request('GET', `${PATH}/${p.id}`)).json()).toMatchObject({
        id: p.id,
        name: p.name,
        accessLevel,
      });
    }
    for (const p of [down, shared]) {
      const read = async () => (await setup.request('GET', `${TR_BASE}${PATH}/${p.id}`, w.asAdmin)).json();
      const before = await read();
      for (const [method, suffix, body] of [
        ['PATCH', '', { name: '不能保存' }],
        ['DELETE', '', undefined],
        ...['start', 'end', 'restart', 'calculate', 'sync'].map((action) => ['POST', `/${action}`, {}] as const),
      ] as const) {
        const res = await op.request(method, `${PATH}/${p.id}${suffix}`, { ifMatch: p.revision, body });
        expect(res.status, `${method} ${suffix}: ${await res.clone().text()}`).toBe(403);
        expect(await res.json()).toMatchObject({ error: { details: { reason: 'PROJECT_READONLY' } } });
        expect(await read()).toEqual(before);
      }
    }
    expect(
      (await op.request('PATCH', `${PATH}/${managed.id}`, { ifMatch: managed.revision, body: { name: '允许管理' } }))
        .status,
    ).toBe(200);
    const page = (await (await op.request('GET', `${PATH}?pageSize=1&page=2`)).json()) as { items: unknown[] };
    expect(page.items).toHaveLength(1);
    const current = (await (await op.request('GET', `${PATH}/${managed.id}`)).json()) as { revision: number };
    const command = { ifMatch: current.revision, body: { name: '降权前幂等修改' }, idempotencyKey: randomUUID() };
    expect((await op.request('PATCH', `${PATH}/${managed.id}`, command)).status).toBe(200);
    const grandchild = await createOrg(setup, w.asAdmin, '再下一级', child);
    const narrower = await createMou(setup, w.asAdmin, [grandchild]);
    expect(
      (
        await setup.request('PUT', `${BASE}/scopes/${op.user.id}/TalentReview`, {
          ...w.asAdmin,
          ifMatch: 1,
          body: { kind: 'mou', mouId: narrower },
        })
      ).status,
    ).toBe(200);
    expect(await (await op.request('GET', `${PATH}/${managed.id}`)).json()).toMatchObject({
      accessLevel: 'readonly',
      name: '降权前幂等修改',
    });
    const replay = await op.request('PATCH', `${PATH}/${managed.id}`, command);
    expect(replay.status, await replay.clone().text()).toBe(403);
    expect(await replay.json()).toMatchObject({ error: { details: { reason: 'PROJECT_READONLY' } } });
  });
});
