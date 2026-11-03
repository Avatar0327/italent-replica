/**
 * F-358（#443 P2，DEC-406 后补-权限）：离职退休设置的入口与配置接口同口径，只认任职设置对象（配置类，admin.other_settings），
 * 入口不再额外要求任职记录查看权。没有任何任职权限的租户管理员：菜单里有入口，三个字典与其余设置页的读取都 200。
 * 仍保留：只有任职记录查看权的成员读字典（表单下拉）不受影响；既无设置权也无记录权的成员看不到入口、读取 403。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { EXIT_DICTIONARY_KINDS } from '@italent/domain';
import { grantMembership, createUser } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { dictionaryPath, EXIT_SETTINGS_OBJECT } from '../../apps/web/src/exit/model.js';
import { exitWorld } from './AC-EXIT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();
const EMPLOYMENT = '/api/tenant/employment';
const CONFIG_READS = [
  `${EMPLOYMENT}/exit-handover-items`,
  `${EMPLOYMENT}/blacklist-rules`,
  `${EMPLOYMENT}/exit-account/settings`,
];

async function world(label: string) {
  const w = await exitWorld(testDb().db, label);
  const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date('2026-10-17T01:00:00Z') });
  await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const plain = await createUser(w.db, { email: `f358-${label}@example.com`, displayName: '普通成员' }, cmd());
  await grantMembership(w.db, { tenantId: w.tenant.id, userId: plain.id, expectedRevision: 0 }, cmd());
  const as = (user: string, path: string) => api.request('GET', path, { tenant: w.tenant.id, user });
  return { as, admin: w.user.id, plain: plain.id };
}
const menuKeys = (snapshot: ServerSnapshot) => menuNodes(PAGES.menus, snapshot).map((item) => item.key);

describe('F-358 离职退休设置入口与配置接口同口径', () => {
  it('没有任职权限的租户管理员：快照里入口显示，三个字典与其余设置读取都 200', async () => {
    const { as, admin } = await world('f358-admin');
    const snapshot = (await (await as(admin, '/api/tenant/permission/me/snapshot')).json()) as ServerSnapshot;
    // 前提：该管理员确实没有任何任职记录入口对象
    expect(snapshot.apps.find((app) => app.app === 'transfer')).toMatchObject({ visible: false, entryObjects: [] });
    expect(snapshot.apps.find((app) => app.app === 'settings')!.entryObjects).toContain(EXIT_SETTINGS_OBJECT);
    expect(menuKeys(snapshot)).toContain('exit-settings');

    for (const kind of EXIT_DICTIONARY_KINDS) {
      const response = await as(admin, dictionaryPath(kind));
      expect(response.status, `${kind} ${await response.clone().text()}`).toBe(200);
    }
    for (const path of CONFIG_READS) expect((await as(admin, path)).status, path).toBe(200);
  });

  it('既无设置权也无任职记录权的成员：看不到入口，字典与设置读取都 403', async () => {
    const { as, plain } = await world('f358-plain');
    const snapshot = (await (await as(plain, '/api/tenant/permission/me/snapshot')).json()) as ServerSnapshot;
    expect(menuKeys(snapshot)).not.toContain('exit-settings');
    for (const kind of EXIT_DICTIONARY_KINDS) expect((await as(plain, dictionaryPath(kind))).status).toBe(403);
    for (const path of CONFIG_READS) expect((await as(plain, path)).status, path).toBe(403);
  });

  it('入口登记：挂企业设置应用、入口对象 = 任职设置对象（与配置接口同一个对象），不再取任职记录对象', () => {
    expect(PAGES.entries.find((item) => item.id === 'exit-settings')).toMatchObject({
      app: 'settings',
      objectCode: EXIT_SETTINGS_OBJECT,
      path: '/exit-settings',
    });
    const snapshot = (entryObjects: string[]) =>
      ({ apps: [{ app: 'settings', visible: true, entryObjects }], adminMenus: [] }) as unknown as ServerSnapshot;
    expect(menuKeys(snapshot([]))).not.toContain('exit-settings');
    expect(menuKeys(snapshot([EXIT_SETTINGS_OBJECT]))).toContain('exit-settings');
  });
});
