/**
 * F-474-6b 第 2 轮返工（Codex 审查 d19e9c698 的 P2-1、P2-2、P3-1）：真实授权器 + 真实迁移后的库。
 * P2-1 业务侧定义目录：普通组织用户没有配置管理能力，读配置接口会 403，目录改走组织业务侧只读接口。
 * P2-2 校验顺序：对象权限与数据范围在前，字段 ID 不是本租户组织定义 → 400，合法定义但无编辑权 → 403。
 */
import { auditEvents, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { ORG_POLICIES } from '../../apps/api/src/modules/org/policy.js';
import { addMember } from './AC-PRM-support.js';
import { resultRows } from './AC-ORG-support.js';
import { AT, customFieldWorld, type CustomFieldWorld, type OrgDto } from './support/f474-6b-world.js';

const database = useTestDb();
const DEFINITIONS = '/custom-field-definitions';
const CONFIG = '/api/tenant/employment/custom-fields?objectType=organization&page=1&pageSize=200';
const unknownId = '00000000-0000-4000-8000-000000000009';

async function counts(w: CustomFieldWorld) {
  return withTenant(database().db, w.world.tenant.id, async (tx) => ({
    versions: resultRows<{ n: number }>(await tx.execute(sql`SELECT count(*)::int AS n FROM org_versions`))[0]!.n,
    audits: (await tx.select().from(auditEvents)).length,
  }));
}
async function defineEmployment(w: CustomFieldWorld, name: string) {
  const created = await w.world.api.request('POST', '/api/tenant/employment/custom-fields', {
    ...w.world.asAdmin,
    ifMatch: 0,
    body: { name, objectType: 'employment', valueType: 'text' },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

describe('AC-F474-6b-R2 业务侧定义目录（P2-1）', () => {
  it('AC-F474-6b-R2-01 无配置管理能力的组织用户经业务侧目录读到有查看权的定义与值；未授权、他租户、非组织定义都不出现', async () => {
    const w = await customFieldWorld(database().db);
    const other = await customFieldWorld(database().db);
    const viewOnly = await w.define('合成仅查看');
    const editable = await w.define('合成可编辑', 'select', [{ value: 'east', label: '合成东区', enabled: true }]);
    const hidden = await w.define('合成无权');
    const foreign = await other.define('合成外租户');
    const employment = await defineEmployment(w, '合成任职字段');
    const top = await w.top();
    const org = await w.seedOrg('目录组织', top.id);
    const op = await w.operator(top.id, { [viewOnly.id]: 'view', [editable.id]: 'edit' });
    // 根因对照：配置接口要配置管理能力，普通组织用户读它得 403
    expect((await w.real.request('GET', CONFIG, op.as)).status).toBe(403);
    const res = await op.request('GET', DEFINITIONS);
    expect(res.status, await res.clone().text()).toBe(200);
    const { items } = (await res.json()) as { items: Record<string, unknown>[] };
    expect(items.map((item) => item.id).sort()).toEqual([viewOnly.id, editable.id].sort());
    const byId = Object.fromEntries(items.map((item) => [item.id as string, item]));
    expect(byId[viewOnly.id]).toMatchObject({ name: '合成仅查看', valueType: 'text', editable: false });
    expect(byId[editable.id]).toMatchObject({ valueType: 'select', editable: true });
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual(['editable', 'id', 'name', 'options', 'valueType']);
    const raw = JSON.stringify(items);
    for (const id of [hidden.id, foreign.id, employment]) expect(raw).not.toContain(id);
    // 同一身份写自己有编辑权的字段、读到值：目录与读写用同一套 custom:<id> 权限
    const saved = await op.request('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { effectiveDate: AT, customFields: { [editable.id]: 'east' } },
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const detail = (await (await op.request('GET', `/organizations/${org.id}?asOf=${AT}`)).json()) as OrgDto;
    expect(detail.customFields).toEqual({ [editable.id]: 'east' });
  });

  it('AC-F474-6b-R2-02 有组织对象查看权但没有任何 custom:<id> 查看权：200 且目录为空', async () => {
    const w = await customFieldWorld(database().db);
    await w.define('合成字段');
    const top = await w.top();
    const op = await w.operator(top.id, {});
    const res = await op.request('GET', DEFINITIONS);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
  });

  it('AC-F474-6b-R2-03 没有组织对象查看权：目录 403，不泄露定义', async () => {
    const w = await customFieldWorld(database().db);
    const def = await w.define('合成字段');
    const nobody = await addMember(w.world, 'nobody');
    const res = await w.real.request('GET', `/api/tenant/org${DEFINITIONS}`, {
      tenant: w.world.tenant.id,
      user: nobody.id,
    });
    expect(res.status, await res.clone().text()).toBe(403);
    expect(await res.clone().text()).not.toContain(def.id);
  });
});

describe('AC-F474-6b-R2 写入校验顺序（P2-2）', () => {
  /** 四个带 customFields 的写入口，同一份请求体。 */
  const routes = (w: CustomFieldWorld, org: OrgDto, parentId: string, customFields: object) => [
    {
      label: 'validate',
      method: 'POST',
      path: '/validate',
      ifMatch: undefined,
      body: { name: `预检${w.suffix}`, parents: { admin: { parentId } }, customFields },
    },
    {
      label: 'create',
      method: 'POST',
      path: '/organizations',
      ifMatch: 0,
      body: { name: `新建${w.suffix}`, parents: { admin: { parentId } }, customFields },
    },
    {
      label: 'update',
      method: 'PATCH',
      path: `/organizations/${org.id}`,
      ifMatch: org.revision,
      body: { effectiveDate: AT, customFields },
    },
    {
      label: 'employment-preview',
      method: 'POST',
      path: `/organizations/${org.id}/employment-preview`,
      ifMatch: undefined,
      body: { effectiveDate: AT, customFields },
    },
  ];

  it('AC-F474-6b-R2-04 真实授权器下：未知、他租户、非组织对象的字段 ID 在四个写入口一律 400，不落版本也不写审计', async () => {
    const w = await customFieldWorld(database().db);
    const other = await customFieldWorld(database().db);
    const own = await w.define('合成本租户');
    const foreign = await other.define('合成外租户');
    const employment = await defineEmployment(w, '合成任职字段');
    const top = await w.top();
    const org = await w.seedOrg('校验组织', top.id);
    const op = await w.operator(top.id, { [own.id]: 'edit' });
    const before = await counts(w);
    for (const id of [unknownId, foreign.id, employment]) {
      for (const alone of [{ [id]: 'x' }, { [own.id]: 'ok', [id]: 'x' }]) {
        for (const r of routes(w, org, top.id, alone)) {
          const res = await op.request(r.method, r.path, { body: r.body, ifMatch: r.ifMatch });
          expect(res.status, `${r.label} ${id} ${await res.clone().text()}`).toBe(400);
          expect((await res.json()).error.code).toBe('VALIDATION_FAILED');
        }
      }
    }
    expect(await counts(w)).toEqual(before);
  });

  it('AC-F474-6b-R2-05 顺序：合法定义但无编辑权仍 403；无对象权限先 403；数据范围外先于字段 ID 校验', async () => {
    const w = await customFieldWorld(database().db);
    const editable = await w.define('合成可编辑');
    const viewOnly = await w.define('合成仅查看');
    const top = await w.top();
    const outside = await w.seedOrg('范围外组织', w.world.tenant.id);
    const org = await w.seedOrg('范围内组织', top.id);
    const op = await w.operator(top.id, { [editable.id]: 'edit', [viewOnly.id]: 'view' });
    const before = await counts(w);
    // 合法定义但无编辑权：403
    for (const r of routes(w, org, top.id, { [viewOnly.id]: 'x' })) {
      const res = await op.request(r.method, r.path, { body: r.body, ifMatch: r.ifMatch });
      expect(res.status, `${r.label} ${await res.clone().text()}`).toBe(403);
    }
    // 没有组织对象权限的成员：非法 ID 也先被对象权限拒绝，不能借 400 探测定义是否存在
    const nobody = await addMember(w.world, 'nobody');
    for (const r of routes(w, org, top.id, { [unknownId]: 'x' })) {
      const res = await w.real.request(r.method, `/api/tenant/org${r.path}`, {
        tenant: w.world.tenant.id,
        user: nobody.id,
        body: r.body,
        ifMatch: r.ifMatch,
      });
      expect(res.status, `${r.label} ${await res.clone().text()}`).toBe(403);
    }
    // 目标组织在数据范围外：先得到范围结果（不存在），而不是字段 ID 的 400
    const out = await op.request('PATCH', `/organizations/${outside.id}`, {
      ifMatch: outside.revision,
      body: { effectiveDate: AT, customFields: { [unknownId]: 'x' } },
    });
    expect(out.status, await out.clone().text()).toBe(404);
    expect(await counts(w)).toEqual(before);
    // 对照：合法且有编辑权的字段照常 200
    const ok = await op.request('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { effectiveDate: AT, customFields: { [editable.id]: 'ok' } },
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});

describe('AC-F474-6b-R2 策略声明（P3-1）', () => {
  it('AC-F474-6b-R2-06 带 customFields 的四个写入口都声明 body+customFields', () => {
    for (const key of [
      'POST /api/tenant/org/validate',
      'POST /api/tenant/org/organizations',
      'PATCH /api/tenant/org/organizations/:id',
      'POST /api/tenant/org/organizations/:id/employment-preview',
    ]) {
      const hit = ORG_POLICIES.lookup(key);
      expect(hit, key).toBeDefined();
      expect(hit!.policy).toMatchObject({ write: { fields: 'body+customFields' } });
    }
  });
});
