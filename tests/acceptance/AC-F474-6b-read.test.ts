/**
 * F-474-6b 组织自定义字段：读取侧裁剪与审计（设计 §5：读取出口按当前查看人的 custom:<id> 裁剪，历史同样裁剪）。
 */
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { auditApi } from './AC-AUD-support.js';
import { uniqueSuffix } from './support/unique.js';
import { AT, customFieldWorld, type CustomFieldWorld, type OrgDto } from './support/f474-6b-world.js';

const database = useTestDb();
const BEFORE = '2026-09-30';

/** 管理视角给组织写入两个字段的值：版本 1 为空，版本 2（AT 起）有 a、b。 */
async function seeded(w: CustomFieldWorld, a: string, b: string, parentId: string) {
  const org = await w.seedOrg('读取组织', parentId);
  const saved = await w.admin('PATCH', `/organizations/${org.id}`, {
    ifMatch: org.revision,
    body: { effectiveDate: AT, customFields: { [a]: '甲值', [b]: '乙值' } },
  });
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { org, current: (await saved.json()) as OrgDto };
}
type Op = Awaited<ReturnType<CustomFieldWorld['operator']>>;
const detail = async (op: Op, id: string, asOf = AT) => {
  const response = await op.request('GET', `/organizations/${id}?asOf=${asOf}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as OrgDto;
};
const listed = async (op: Op, id: string, asOf = AT) => {
  const response = await op.request('GET', `/organizations?asOf=${asOf}&pageSize=100`);
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { items: OrgDto[] };
  return items.find((item) => item.id === id);
};

describe('AC-F474-6b 组织自定义字段读取裁剪', () => {
  it('AC-F474-6b-09 fail-closed：未授权字段在详情、列表、历史版本里没有值也没有键；无任何字段权限则整个键都不出现', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成甲');
    const b = await w.define('合成乙');
    const top = await w.top();
    const { org } = await seeded(w, a.id, b.id, top.id);
    const onlyA = await w.operator(top.id, { [a.id]: 'view' }, 'only-a');
    const none = await w.operator(top.id, {}, 'none');
    expect((await detail(onlyA, org.id)).customFields).toEqual({ [a.id]: '甲值' });
    expect((await listed(onlyA, org.id))?.customFields).toEqual({ [a.id]: '甲值' });
    // 历史：版本 1 没有值，裁剪后为空对象或缺省，但不得出现 b
    const history = await detail(onlyA, org.id, BEFORE);
    expect(Object.keys(history.customFields ?? {})).toEqual([]);
    for (const row of [await detail(none, org.id), await listed(none, org.id), await detail(none, org.id, BEFORE)]) {
      expect(row).toBeDefined();
      expect(Object.hasOwn(row!, 'customFields')).toBe(false);
    }
    expect(JSON.stringify(await detail(none, org.id))).not.toContain('乙值');
    expect(JSON.stringify(await detail(onlyA, org.id))).not.toContain('乙值');
    // 管理视角（全放行）对照：两个值都在
    const full = await w.admin('GET', `/organizations/${org.id}?asOf=${AT}`);
    expect(((await full.json()) as OrgDto).customFields).toEqual({ [a.id]: '甲值', [b.id]: '乙值' });
  });

  it('AC-F474-6b-10 撤销字段查看权后下一次请求即不再返回，历史版本同样按当前权限裁剪', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成甲');
    const b = await w.define('合成乙');
    const top = await w.top();
    const { org } = await seeded(w, a.id, b.id, top.id);
    const op = await w.operator(top.id, { [a.id]: 'view', [b.id]: 'view' });
    expect((await detail(op, org.id)).customFields).toEqual({ [a.id]: '甲值', [b.id]: '乙值' });
    await op.regrant({ [a.id]: 'view' });
    expect((await detail(op, org.id)).customFields).toEqual({ [a.id]: '甲值' });
    expect((await listed(op, org.id))?.customFields).toEqual({ [a.id]: '甲值' });
    await op.regrant({});
    for (const asOf of [AT, BEFORE]) expect(Object.hasOwn(await detail(op, org.id, asOf), 'customFields')).toBe(false);
  });

  it('AC-F474-6b-11 写入响应同样裁剪：只有编辑权的字段之外，已存在的无权字段值不会随响应泄露', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成甲');
    const b = await w.define('合成乙');
    const top = await w.top();
    const { current } = await seeded(w, a.id, b.id, top.id);
    const op = await w.operator(top.id, { [a.id]: 'edit' });
    const response = await op.request('PATCH', `/organizations/${current.id}`, {
      ifMatch: current.revision,
      body: { effectiveDate: '2026-10-02', customFields: { [a.id]: '新甲值' } },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const saved = (await response.json()) as OrgDto;
    expect(saved.customFields).toEqual({ [a.id]: '新甲值' });
    // 无权字段 b 的值没有被这次写入抹掉，管理视角仍在
    const full = await w.admin('GET', `/organizations/${current.id}?asOf=2026-10-02`);
    expect(((await full.json()) as OrgDto).customFields).toEqual({ [a.id]: '新甲值', [b.id]: '乙值' });
  });

  it('AC-F474-6b-12 树与架构图节点不带自定义字段（设计 §6：卡片不显示）', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成甲');
    const b = await w.define('合成乙');
    const top = await w.top();
    await seeded(w, a.id, b.id, top.id);
    const op = await w.operator(top.id, { [a.id]: 'view', [b.id]: 'view' });
    for (const view of ['tree', 'chart']) {
      const response = await op.request('GET', `/organizations/${view}?asOf=${AT}&dimension=admin`);
      expect(response.status, await response.clone().text()).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('customFields');
      expect(text).not.toContain('甲值');
    }
  });

  it('AC-F474-6b-13 审计：前后值取自上一版本且与业务同事务；无该字段查看权的审计读取者看不到前后值与差异', async () => {
    const w = await customFieldWorld(database().db);
    const a = await w.define('合成甲');
    const b = await w.define('合成乙');
    const top = await w.top();
    const org = await w.seedOrg('审计组织', top.id);
    const saved = await w.admin('PATCH', `/organizations/${org.id}`, {
      ifMatch: org.revision,
      body: { effectiveDate: AT, customFields: { [a.id]: '甲旧值', [b.id]: '乙旧值' } },
    });
    const first = (await saved.json()) as OrgDto;
    const changed = await w.admin('PATCH', `/organizations/${org.id}`, {
      ifMatch: first.revision,
      body: { effectiveDate: '2026-10-02', customFields: { [a.id]: '甲新值', [b.id]: '乙新值' } },
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    const audit = auditApi(database().db, `${AT}T01:00:00.000Z`, { authorize: undefined });
    const reader = async (visible: string[]) => {
      const member = await memberWithAdminRole(w.world, 'audit_admin', `aud6b${uniqueSuffix()}`);
      const profile = await createProfile(w.world, `aud6b-${uniqueSuffix()}`);
      const permission = await setObjectPermission(
        w.world,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: [...MODULE_OBJECTS.organization.fields.map((field) => field.code), ...visible].map((fieldCode) => ({
            fieldCode,
            view: true,
            edit: false,
          })),
          buttons: [],
        },
        MODULE_OBJECTS.organization.code,
      );
      expect(permission.status, await permission.clone().text()).toBe(200);
      const all = await w.world.api.request(
        'PUT',
        `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`,
        { ...w.world.asAdmin, ifMatch: 0, body: { targetKind: 'app', targetCode: '', seeAll: true } },
      );
      expect(all.status, await all.clone().text()).toBe(200);
      await makeGrantable(w.world, [profile.id]);
      expect((await grant(w.world, member.user.id, profile.id)).status).toBe(201);
      return member.as;
    };
    const onlyA = await reader([`custom:${a.id}`]);
    const blind = await reader([]);
    const full = await audit.dataChanges(w.world.asAdmin, { objectId: org.id });
    const update = full.items.find((item) => item.action === 'org.update' && JSON.stringify(item).includes('乙新值'));
    expect(update, '管理视角能看到两个字段的差异').toBeDefined();
    const seenA = await audit.dataChanges(onlyA, { objectId: org.id });
    const seenAText = JSON.stringify(seenA.items) + JSON.stringify(await audit.dataChange(onlyA, update!.id));
    expect(seenAText).toContain('甲新值');
    expect(seenAText).not.toContain('乙新值');
    expect(seenAText).not.toContain('乙旧值');
    const seenNone = await audit.dataChanges(blind, { objectId: org.id });
    const noneText = JSON.stringify(seenNone.items) + JSON.stringify(await audit.dataChange(blind, update!.id));
    for (const hidden of ['甲新值', '甲旧值', '乙新值', '乙旧值']) expect(noneText).not.toContain(hidden);
  });
});
