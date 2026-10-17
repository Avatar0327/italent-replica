/**
 * AC-DM-31（设置页部分，R2-T03 FE2b）：离职三个字典设置页的纯规则与接口形态（设计 §2.1、§3、§18）。
 *   - 冒烟夹具与真实接口一致：管理员读任职设置对象的返回、字典行的键集合（DEC-502① f）；
 *   - 写能力只看任职设置对象的数据操作与可编辑字段（DEC-502① c）：只有任职记录查看权的成员页面只读；
 *   - 回执按实际提交的版本核对（DEC-502① a）：新增 0 → 1，修改 n → n + 1；
 *   - 调序只改本条显示顺序，取严格落在相邻两条之间的值，不依赖编码排序；没有空位时不猜；
 *   - 菜单：任职应用（调动管理）下的独立入口，与入职 / Offer 同层，只在入口对象含任职记录时显示。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { EXIT_DICTIONARY_KINDS, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { presetRows, settingsPermission } from '../../apps/web/smoke/exit-fixtures.js';
import {
  dictionaryPath,
  EXIT_SETTINGS_OBJECT,
  moveTarget,
  parseEntries,
  parseEntryReceipt,
  writeAccess,
  type Entry,
} from '../../apps/web/src/exit/model.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { exitWorld } from './AC-EXIT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

async function permissionWorld() {
  const w = await exitWorld(testDb().db, 'fe2b');
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-17T01:00:00Z') });
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const asAdmin = { tenant: w.tenant.id, user: w.user.id };
  const seed = { db: w.db, tenant: w.tenant, admin: w.user, adminRecord, api, asAdmin };
  const viewer = await addMember(seed, '离职字典查看人');
  const profile = await createProfile(seed, 'exit-settings-viewer');
  const record = MODULE_OBJECTS.employmentRecord;
  const fields = record.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false }));
  const permission = { dataOperations: { create: false, update: false, delete: false }, fields, buttons: [] };
  expect((await setObjectPermission(seed, profile, permission, record.code)).status).toBe(200);
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, viewer.id, profile.id)).status).toBe(201);
  const as = (user: string, method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, path, { tenant: w.tenant.id, user, body, ifMatch });
  return { w, as, admin: w.user.id, viewer: viewer.id };
}
const objectPath = `/api/tenant/permission/me/objects/${encodeURIComponent(EXIT_SETTINGS_OBJECT)}`;

describe('AC-DM-31 FE2b 夹具与真实接口一致', () => {
  it('管理员读任职设置对象的返回等于冒烟夹具，可新增、可编辑字典四个字段；只有查看权的成员页面只读', async () => {
    const { as, admin, viewer } = await permissionWorld();
    const adminRes = await as(admin, 'GET', objectPath);
    expect(adminRes.status).toBe(200);
    const adminPermission = await adminRes.json();
    expect(adminPermission).toEqual(settingsPermission);
    expect(writeAccess(adminPermission)).toEqual({
      create: true,
      createFields: ['code', 'name', 'enabled', 'displayOrder'],
      updateFields: ['name', 'enabled', 'displayOrder'],
    });
    const viewerRes = await as(viewer, 'GET', objectPath);
    const viewerPermission = viewerRes.status === 200 ? await viewerRes.json() : undefined;
    expect(writeAccess(viewerPermission)).toEqual({ create: false, createFields: [], updateFields: [] });
    // 快照摘要（未懒加载明细）不授予写能力。
    expect(writeAccess({ ...settingsPermission, summary: true })).toMatchObject({ create: false, updateFields: [] });
  });

  it.each(EXIT_DICTIONARY_KINDS)('%s：列表行键集合与夹具一致；新增 / 修改回执按实际提交的版本核对', async (kind) => {
    const { as, admin, viewer } = await permissionWorld();
    const path = dictionaryPath(kind);
    expect(path).toBe(`/api/tenant/employment/exits/dictionaries/${kind}`);
    const created = await as(admin, 'POST', path, { code: `fe2b_${kind}`, name: '合成项' }, 0);
    expect(created.status, await created.clone().text()).toBe(201);
    const receipt = await created.json();
    expect(parseEntryReceipt(receipt, { revision: 0 })).toEqual({ id: receipt.id });
    const list = await as(viewer, 'GET', path);
    expect(list.status).toBe(200);
    const items = parseEntries(await list.json());
    expect(items.length).toBeGreaterThan(1);
    const fixtureKeys = Object.keys(presetRows(kind)[0]!).sort();
    for (const item of items) expect(Object.keys(item).sort()).toEqual(fixtureKeys);
    const updated = await as(admin, 'PUT', `${path}/${receipt.id}`, { name: '合成改名' }, 1);
    expect(updated.status, await updated.clone().text()).toBe(200);
    const next = await updated.json();
    expect(parseEntryReceipt(next, { id: receipt.id, revision: 1 })).toEqual({ id: receipt.id });
    expect(() => parseEntryReceipt(next, { id: receipt.id, revision: 2 })).toThrow();
    expect(() => parseEntryReceipt(next, { id: items.find((e) => e.id !== receipt.id)!.id, revision: 1 })).toThrow();
    expect(() => parseEntryReceipt({ ...next, revision: '2' }, { id: receipt.id, revision: 1 })).toThrow();
  });

  it('列表形态不对按读取失败处理，不当作空字典', () => {
    expect(() => parseEntries({})).toThrow();
    expect(() => parseEntries({ items: [{ id: 'x', code: 'a', name: 'b', enabled: 'yes' }] })).toThrow();
    expect(parseEntries({ items: [] })).toEqual([]);
  });
});

const rows = (...orders: number[]): Entry[] =>
  orders.map((displayOrder, index) => ({
    id: `id-${index}`,
    code: `c${index}`,
    name: `n${index}`,
    enabled: true,
    displayOrder,
    revision: 1,
  }));

describe('AC-DM-31 FE2b 调序（只改本条显示顺序）', () => {
  it('首行不能上移、末行不能下移：不提供按钮', () => {
    expect(moveTarget(rows(10, 20, 30), 0, -1)).toBeUndefined();
    expect(moveTarget(rows(10, 20, 30), 2, 1)).toBeUndefined();
  });
  it('有空位：取严格落在越过的那条与再下一条之间的值', () => {
    expect(moveTarget(rows(10, 20, 30), 2, -1)).toBe(15);
    expect(moveTarget(rows(10, 20, 30), 0, 1)).toBe(25);
    expect(moveTarget(rows(10, 20, 30), 1, -1)).toBe(0);
    expect(moveTarget(rows(10, 20, 30), 1, 1)).toBe(40);
    // 与越过的那条显示顺序相同（靠编码排序）时，也要严格小于 / 大于它，不依赖编码排序规则。
    expect(moveTarget(rows(10, 20, 20), 2, -1)).toBe(15);
    expect(moveTarget(rows(3), 0, -1)).toBeUndefined();
  });
  it('没有空位或越界：返回 null，由页面提示改显示顺序，不猜位置', () => {
    expect(moveTarget(rows(5, 6, 7), 2, -1)).toBeNull();
    expect(moveTarget(rows(5, 5, 7), 2, -1)).toBeNull();
    expect(moveTarget(rows(0, 0), 1, -1)).toBeNull();
    expect(moveTarget(rows(99990, 100000), 0, 1)).toBeNull();
    expect(moveTarget(rows(1, 2, 3), 0, 1)).toBeNull();
  });
  it('落位不越过显示顺序上下限（0～100000）', () => {
    expect(moveTarget(rows(4, 8), 1, -1)).toBe(0);
    expect(moveTarget(rows(99995, 99999), 0, 1)).toBe(100000);
  });
});

describe('AC-DM-31 FE2b 菜单登记', () => {
  it('离职退休设置在任职应用下独立登记（与入职 / Offer 同层），只在入口对象含任职记录时显示', () => {
    const entry = PAGES.entries.find((item) => item.id === 'exit-settings');
    expect(entry).toMatchObject({
      app: 'transfer',
      module: 'exit',
      label: '离职退休设置',
      objectCode: 'TenantBase.EmploymentRecord',
      path: '/exit-settings',
    });
    const snapshot = (entryObjects: string[]) =>
      ({ apps: [{ app: 'transfer', visible: true, entryObjects }], adminMenus: [] }) as unknown as ServerSnapshot;
    expect(menuNodes(PAGES.menus, snapshot([])).some((item) => item.key === 'exit-settings')).toBe(false);
    expect(
      menuNodes(PAGES.menus, snapshot(['TenantBase.EmploymentRecord'])).some((item) => item.key === 'exit-settings'),
    ).toBe(true);
  });
});
