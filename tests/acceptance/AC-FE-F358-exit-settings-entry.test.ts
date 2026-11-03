/**
 * F-358（#443 P2，DEC-406 后补-权限；DEC-780 定向）：离职退休设置入口留在人事异动应用，入口授权对象保持任职记录
 * （TenantBase.EmploymentRecord），接口向入口看齐：三个配置读取（交接事项 / 自动加黑规则 / 离职账号设置）在任职设置对象
 * 授权之外还要求任职记录查看权；写接口不动；三个字典 GET 保持基线（任职记录查看权，供离职表单下拉）。
 * 所以没有任职记录查看权的租户管理员：入口不显示、配置读取 403；有任职记录查看权 + 配置权：入口显示、配置读取 200；
 * 只有任职记录查看权、无配置权：字典读取 200（表单下拉不受影响）、配置读取仍 403。
 */
import { bootstrapTenantAdmin } from '@italent/api';
import { EXIT_DICTIONARY_KINDS, MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { PAGES } from '../../apps/web/src/foundation/routes.js';
import { dictionaryPath, EXIT_RECORD_OBJECT } from '../../apps/web/src/exit/model.js';
import { exitWorld } from './AC-EXIT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
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
  const adminRecord = await bootstrapTenantAdmin(w.db, { tenantId: w.tenant.id, userId: w.user.id }, cmd());
  const seed = {
    db: w.db,
    tenant: w.tenant,
    admin: w.user,
    adminRecord,
    api,
    asAdmin: { tenant: w.tenant.id, user: w.user.id },
  };
  // 只有任职记录查看权的身份（不含任职设置对象，也不是企业管理员）
  const profile = await createProfile(seed, `f358-${label}`);
  const record = MODULE_OBJECTS.employmentRecord;
  const fields = record.fields.map((f) => ({ fieldCode: f.code, view: true, edit: false }));
  const permission = { dataOperations: { create: false, update: false, delete: false }, fields, buttons: [] };
  expect((await setObjectPermission(seed, profile, permission, record.code)).status).toBe(200);
  await makeGrantable(seed, [profile.id]);
  const viewer = await addMember(seed, '任职记录查看人');
  expect((await grant(seed, viewer.id, profile.id)).status).toBe(201);
  const as = (user: string, path: string) => api.request('GET', path, { tenant: w.tenant.id, user });
  const snapshotOf = async (user: string) =>
    (await (await as(user, '/api/tenant/permission/me/snapshot')).json()) as ServerSnapshot;
  return { seed, as, snapshotOf, admin: w.user.id, viewer: viewer.id, profileId: profile.id };
}
const menuKeys = (snapshot: ServerSnapshot) => menuNodes(PAGES.menus, snapshot).map((item) => item.key);

describe('F-358 / DEC-780 离职退休设置：接口向入口看齐', () => {
  it('没有任职记录查看权的租户管理员：入口不显示，三个配置读取 403', async () => {
    const { as, snapshotOf, admin } = await world('admin-no-record');
    const snapshot = await snapshotOf(admin);
    // 前提：该管理员确实没有任职记录入口对象
    expect(snapshot.apps.find((app) => app.app === 'transfer')).toMatchObject({ visible: false, entryObjects: [] });
    for (const path of CONFIG_READS) expect((await as(admin, path)).status, path).toBe(403);
    expect(menuKeys(snapshot)).not.toContain('exit-settings');
  });

  it('租户管理员 + 任职记录查看权：入口显示，三个配置读取与字典读取都 200', async () => {
    const { seed, as, snapshotOf, admin, profileId } = await world('admin-with-record');
    expect((await grant(seed, admin, profileId)).status).toBe(201);
    const snapshot = await snapshotOf(admin);
    expect(snapshot.apps.find((app) => app.app === 'transfer')!.entryObjects).toContain(EXIT_RECORD_OBJECT);
    expect(menuKeys(snapshot)).toContain('exit-settings');
    for (const path of CONFIG_READS) expect((await as(admin, path)).status, path).toBe(200);
    for (const kind of EXIT_DICTIONARY_KINDS) expect((await as(admin, dictionaryPath(kind))).status).toBe(200);
  });

  it('只有任职记录查看权、无配置权：字典读取 200（表单下拉不受影响），配置读取仍 403', async () => {
    const { as, viewer } = await world('viewer');
    for (const kind of EXIT_DICTIONARY_KINDS) {
      const response = await as(viewer, dictionaryPath(kind));
      expect(response.status, `${kind} ${await response.clone().text()}`).toBe(200);
    }
    for (const path of CONFIG_READS) expect((await as(viewer, path)).status, path).toBe(403);
  });

  it('入口登记：留在人事异动应用，入口对象 = 任职记录（不挪到企业设置、不改成任职设置）', () => {
    expect(PAGES.entries.find((item) => item.id === 'exit-settings')).toMatchObject({
      app: 'transfer',
      objectCode: EXIT_RECORD_OBJECT,
      path: '/exit-settings',
    });
    const snapshot = (entryObjects: string[]) =>
      ({ apps: [{ app: 'transfer', visible: true, entryObjects }], adminMenus: [] }) as unknown as ServerSnapshot;
    expect(menuKeys(snapshot([]))).not.toContain('exit-settings');
    expect(menuKeys(snapshot([EXIT_RECORD_OBJECT]))).toContain('exit-settings');
  });
});
