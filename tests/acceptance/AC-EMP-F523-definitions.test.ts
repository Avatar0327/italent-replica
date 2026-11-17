// F-523a：真实 HTTP / 授权器 / 迁移库；仅使用合成定义，不依赖员工数据范围或配置管理能力。
import { randomUUID } from 'node:crypto';
import { grantMembership } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { define } from './AC-F474-6c-support.js';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const path = '/api/tenant/employment/custom-field-definitions';
const config = '/api/tenant/employment/custom-fields?objectType=employment';
const object = 'TenantBase.EmploymentRecord';
const options = [
  { value: 'east', label: '合成东区', enabled: true },
  { value: 'west', label: '合成西区', enabled: false },
];

async function actor(w: PermissionWorld, view: string[] = [], edit: string[] = []) {
  const user = await addMember(w, 'hr');
  const profile = await createProfile(w, `f523-${randomUUID()}`);
  const configure = async (viewIds: string[], editIds: string[] = []) => {
    const res = await setObjectPermission(
      w,
      profile,
      {
        dataOperations: { create: false, update: editIds.length > 0, delete: false },
        fields: [...new Set([...viewIds, ...editIds])].map((id) => ({
          fieldCode: `custom:${id}`,
          view: true,
          edit: editIds.includes(id),
        })),
        buttons: [],
      },
      object,
    );
    expect(res.status, await res.clone().text()).toBe(200);
  };
  await configure(view, edit);
  await makeGrantable(w, [profile.id]);
  expect((await grant(w, user.id, profile.id)).status).toBe(201);
  // 故意不授人员数据范围：目录没有任职行，不应依赖范围或按钮。
  return { as: { tenant: w.tenant.id, user: user.id }, configure };
}

async function list(w: PermissionWorld, as: { tenant: string; user: string }) {
  const res = await w.api.request('GET', path, as);
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { items: Record<string, unknown>[] };
}

describe('AC-EMP-F523 任职业务侧只读自定义字段定义', () => {
  it('AC-EMP-F523-a 无配置权 HR 只读取可见定义及最小字段，编辑标记与选项保持先例口径', async () => {
    const w = await seedPermissionWorld(database().db);
    const viewOnly = await define(w, 'text', [], 'employment');
    const editable = await define(w, 'select', options, 'employment');
    await define(w, 'text', [], 'employment');
    const hr = await actor(w, [viewOnly, editable], [editable]);
    expect((await w.api.request('GET', config, hr.as)).status).toBe(403);
    const expected = [
      { id: viewOnly, name: '合成text', valueType: 'text', options: [], editable: false },
      { id: editable, name: '合成select', valueType: 'select', options, editable: true },
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(await list(w, hr.as)).toEqual({ items: expected });
  });

  it('AC-EMP-F523-b 同一 HR 撤字段查看权后立即隐藏定义，撤编辑权后标记只读', async () => {
    const w = await seedPermissionWorld(database().db);
    const a = await define(w, 'text', [], 'employment');
    const b = await define(w, 'text', [], 'employment');
    const hr = await actor(w, [a, b], [b]);
    expect((await list(w, hr.as)).items).toHaveLength(2);
    await hr.configure([b]);
    expect(await list(w, hr.as)).toEqual({
      items: [{ id: b, name: '合成text', valueType: 'text', options: [], editable: false }],
    });
  });

  it('AC-EMP-F523-c 无任职对象查看权返回 403，错误不泄露定义', async () => {
    const w = await seedPermissionWorld(database().db);
    const id = await define(w, 'text', [], 'employment');
    const user = await addMember(w, 'nobody');
    const res = await w.api.request('GET', path, { tenant: w.tenant.id, user: user.id });
    expect(res.status, await res.clone().text()).toBe(403);
    expect((await res.clone().json()).error.code).toBe('FORBIDDEN');
    expect(await res.text()).not.toContain(id);
  });

  it('AC-EMP-F523-d 同一 HR 访问业务接口 200、配置接口仍 403', async () => {
    const w = await seedPermissionWorld(database().db);
    const id = await define(w, 'text', [], 'employment');
    const hr = await actor(w, [id]);
    expect((await list(w, hr.as)).items).toHaveLength(1);
    const res = await w.api.request('GET', config, hr.as);
    expect(res.status, await res.clone().text()).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  it('AC-EMP-F523-e 双租户成员按当前租户隔离定义，非任职对象的定义不出现', async () => {
    const w = await seedPermissionWorld(database().db);
    const other = await seedPermissionWorld(database().db);
    const own = await define(w, 'text', [], 'employment');
    const foreign = await define(other, 'text', [], 'employment');
    for (const type of ['personnel', 'organization', 'contract']) await define(w, 'text', [], type);
    // 同一用户拥有两个租户的真实任职对象权，证明隔离不是依赖“另一租户无成员身份”。
    const hr = await actor(w, [own]);
    await grantMembership(other.db, { tenantId: other.tenant.id, userId: hr.as.user, expectedRevision: 0 }, cmd());
    const profile = await createProfile(other, `f523-other-${randomUUID()}`);
    const permission = await setObjectPermission(
      other,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: [{ fieldCode: `custom:${foreign}`, view: true, edit: false }],
        buttons: [],
      },
      object,
    );
    expect(permission.status, await permission.clone().text()).toBe(200);
    await makeGrantable(other, [profile.id]);
    expect((await grant(other, hr.as.user, profile.id)).status).toBe(201);
    expect((await list(w, hr.as)).items.map((item) => item.id)).toEqual([own]);
    expect((await list(w, { ...hr.as, tenant: other.tenant.id })).items.map((item) => item.id)).toEqual([foreign]);
  });

  it('AC-EMP-F523-f 有对象查看权但无字段查看权返回空目录', async () => {
    const w = await seedPermissionWorld(database().db);
    await define(w, 'text', [], 'employment');
    const hr = await actor(w);
    expect(await list(w, hr.as)).toEqual({ items: [] });
  });

  it('AC-EMP-F523-g 租户没有定义时返回空目录', async () => {
    const w = await seedPermissionWorld(database().db);
    const hr = await actor(w);
    expect(await list(w, hr.as)).toEqual({ items: [] });
  });
});
