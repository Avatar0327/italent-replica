/**
 * F-327（DEC-685④）：账号停用时间配置页的纯规则与接口形态。
 *   - 冒烟夹具与真实接口一致：GET 默认值、PUT 回执、明确拒绝与版本冲突的错误码、管理员快照里的 other_settings 菜单；
 *   - 写能力 fail-closed：任职设置对象明细的修改权 + other_settings（PUT 唯一准入）；普通成员读写都被拒；
 *   - 请求体是整份严格 DTO：关闭提前停用时依据与时间提交 null；回执版本 = 提交版本 + 1；
 *   - 菜单：作为“离职退休设置”的第 4 个页签，不新增菜单入口。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  accountStopDefault,
  accountStopRejected,
  otherSettingsMenu,
} from '../../apps/web/smoke/account-stop-fixtures.js';
import { settingsPermission } from '../../apps/web/smoke/exit-fixtures.js';
import {
  ACCOUNT_STOP_PATH,
  accountStopBody,
  accountStopValues,
  accountStopWritable,
  parseAccountStop,
  parseAccountStopReceipt,
} from '../../apps/web/src/exit/account-stop.js';
import { EXIT_SETTINGS_OBJECT } from '../../apps/web/src/exit/model.js';
import type { MenuNode } from '../../apps/web/src/foundation/permission-snapshot.js';
import { MENU_ROUTES } from '../../apps/web/src/foundation/routes.js';
import { exitWorld } from './AC-EXIT-support.js';
import { addMember } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const enabled = { earlyEnabled: true, basis: 'actual_leave_date', time: '19:00', inReview: true };

/**
 * 管理员 + 一名普通成员。任职设置是配置类对象（object-access.ts）：读写都只认 admin.other_settings，
 * 所以普通成员读对象权限与配置都是 403，页面无权；“能读不能写”目前没有真实角色，只读态是 fail-closed 兜底。
 */
async function permissionWorld() {
  const w = await exitWorld(testDb().db, 'f327');
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-30T01:00:00Z') });
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const asAdmin = { tenant: w.tenant.id, user: w.user.id };
  const member = await addMember({ db: w.db, tenant: w.tenant, admin: w.user, adminRecord, api, asAdmin }, '合成成员');
  const as = (user: string, method: string, path: string, body?: unknown, ifMatch?: number) =>
    api.request(method, path, { tenant: w.tenant.id, user, body, ifMatch });
  return { as, admin: w.user.id, member: member.id };
}
const objectPath = `/api/tenant/permission/me/objects/${encodeURIComponent(EXIT_SETTINGS_OBJECT)}`;
const snapshotPath = '/api/tenant/permission/me/snapshot';
/** 与 settings/pages.ts 的 children 相同：企业设置下一层是 adminMenus，editable 原样带下去。 */
const menusOf = (adminMenus: { code: string; editable: boolean }[]): MenuNode[] => [
  {
    key: 'settings',
    label: '企业设置',
    path: '/settings',
    group: 'settings',
    children: adminMenus.map((menu) => ({
      key: menu.code,
      label: menu.code,
      path: '',
      group: 'settings',
      editable: menu.editable,
    })),
  },
];

describe('AC-FE-F327 夹具与真实接口一致', () => {
  it('GET 默认值等于夹具；PUT 回执按提交版本 + 1 核对；400 / 409 错误码与夹具一致', async () => {
    const { as, admin } = await permissionWorld();
    expect(ACCOUNT_STOP_PATH).toBe('/api/tenant/employment/exit-account/settings');
    const read = await as(admin, 'GET', ACCOUNT_STOP_PATH);
    expect(read.status).toBe(200);
    const initial = await read.json();
    expect(initial).toEqual(accountStopDefault);
    expect(parseAccountStop(initial)).toEqual(accountStopDefault);

    const saved = await as(admin, 'PUT', ACCOUNT_STOP_PATH, enabled, 0);
    expect(saved.status, await saved.clone().text()).toBe(200);
    const receipt = await saved.json();
    expect(Object.keys(receipt).sort()).toEqual(Object.keys(accountStopDefault).sort());
    expect(parseAccountStopReceipt(receipt, 0)).toEqual({ id: 'settings' });
    expect(() => parseAccountStopReceipt(receipt, 1)).toThrow();

    // 关闭提前停用：依据与时间提交 null，后端接受并原样回显。
    const off = accountStopBody(accountStopValues(parseAccountStop(receipt)), { earlyEnabled: false });
    expect(off).toEqual({ earlyEnabled: false, basis: null, time: null, inReview: true });
    const closed = await as(admin, 'PUT', ACCOUNT_STOP_PATH, off, 1);
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect(await closed.json()).toEqual({ ...off, revision: 2 });

    const rejected = await as(admin, 'PUT', ACCOUNT_STOP_PATH, { ...enabled, time: '24:00' }, 2);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject(accountStopRejected);
    const stale = await as(admin, 'PUT', ACCOUNT_STOP_PATH, enabled, 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });
  });

  it('管理员快照含可编辑的 other_settings 菜单，可保存；普通成员读写都被拒、页面不可写', async () => {
    const { as, admin, member } = await permissionWorld();
    const adminSnapshot = await (await as(admin, 'GET', snapshotPath)).json();
    expect(adminSnapshot.adminMenus).toContainEqual(otherSettingsMenu);
    const adminPermission = await (await as(admin, 'GET', objectPath)).json();
    expect(adminPermission).toEqual(settingsPermission);
    expect(accountStopWritable(adminPermission, menusOf(adminSnapshot.adminMenus))).toBe(true);

    const memberSnapshot = await (await as(member, 'GET', snapshotPath)).json();
    expect(memberSnapshot.adminMenus.map((menu: { code: string }) => menu.code)).not.toContain(otherSettingsMenu.code);
    expect((await as(member, 'GET', objectPath)).status).toBe(403);
    expect(accountStopWritable(undefined, menusOf(memberSnapshot.adminMenus))).toBe(false);
    expect((await as(member, 'GET', ACCOUNT_STOP_PATH)).status).toBe(403);
    expect((await as(member, 'PUT', ACCOUNT_STOP_PATH, enabled, 0)).status).toBe(403);
  });
});

describe('AC-FE-F327 纯规则', () => {
  it('回显形态不对按读取失败处理，不当作默认值', () => {
    expect(() => parseAccountStop({ ...accountStopDefault, extra: 1 })).toThrow();
    expect(() => parseAccountStop({ ...accountStopDefault, time: '7:00' })).toThrow();
    expect(() => parseAccountStop({ ...accountStopDefault, basis: 'effective_date' })).toThrow();
    expect(() => parseAccountStop({ ...accountStopDefault, earlyEnabled: true })).toThrow();
    expect(() => parseAccountStop({ ...accountStopDefault, revision: '0' })).toThrow();
    expect(() => parseAccountStop([])).toThrow();
    expect(parseAccountStop({ ...enabled, revision: 3 })).toEqual({ ...enabled, revision: 3 });
  });

  it('请求体是整份 DTO：未改项取最新全量；关闭提前停用时依据与时间为 null', () => {
    const full = { earlyEnabled: true, basis: 'last_work_date', time: '18:30', inReview: false };
    expect(accountStopBody(full, { time: '20:00' })).toEqual({ ...full, time: '20:00' });
    expect(accountStopBody(full, { earlyEnabled: false })).toEqual({
      earlyEnabled: false,
      basis: null,
      time: null,
      inReview: false,
    });
    expect(accountStopBody(full, { inReview: true })).toEqual({ ...full, inReview: true });
  });

  it('写能力 fail-closed：缺任一条件只读', () => {
    const menus = menusOf([{ code: 'other.mou_settings', editable: true }]);
    expect(accountStopWritable(settingsPermission, menus)).toBe(true);
    expect(accountStopWritable(undefined, menus)).toBe(false);
    expect(accountStopWritable({ ...settingsPermission, summary: true }, menus)).toBe(false);
    const readOnly = { ...settingsPermission, dataOperations: { ...settingsPermission.dataOperations, update: false } };
    expect(accountStopWritable(readOnly, menus)).toBe(false);
    expect(accountStopWritable(settingsPermission, menusOf([{ code: 'other.mou_settings', editable: false }]))).toBe(
      false,
    );
    expect(accountStopWritable(settingsPermission, menusOf([]))).toBe(false);
    expect(accountStopWritable(settingsPermission, [])).toBe(false);
  });

  it('不新增菜单入口：仍是“离职退休设置”一个入口，账号停用时间是其中的页签', () => {
    const exit = MENU_ROUTES.filter((route) => route.module === 'exit');
    // 离职管理（FE-R2c2，/exits）是独立的列表页，不是 F-327 新增的入口；F-327 只要求账号停用时间不单独成菜单。
    expect(exit.map((route) => [route.id, route.path])).toEqual([
      ['exit-settings', '/exit-settings'],
      ['exits', '/exits'],
    ]);
  });
});
