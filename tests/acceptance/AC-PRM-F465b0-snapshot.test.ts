import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  myObject,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import type { ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import { menuNodes } from '../../apps/web/src/foundation/permission-snapshot.js';
import { collectPages } from '../../apps/web/src/foundation/page-registry.js';

const database = useTestDb();
const reports = [MODULE_OBJECTS.hrRoster, MODULE_OBJECTS.hrMovementReport, MODULE_OBJECTS.hrStructureReport];
const registry = collectPages(
  {
    '../fixture/pages.ts': {
      pages: {
        apps: [{ app: 'staff', label: '员工', group: 'people' }],
        entries: [
          { id: 'reports', app: 'staff', label: '报表', group: 'people', objectCodes: reports.map((o) => o.code) },
        ],
      },
    },
  },
  ['staff'],
);
let world: PermissionWorld;
beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
});
async function snapshot(user: string) {
  const response = await world.api.request('GET', '/api/tenant/permission/me/snapshot', {
    user,
    tenant: world.tenant.id,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ServerSnapshot;
}
describe('AC-PRM-F465b0 / DEC-803① 真实权限快照', () => {
  it.each(reports)('只授予 $code 查看权，staff 仅返回该对象，菜单可见', async (object) => {
    const member = await addMember(world, 'report-reader');
    const profile = await createProfile(world, `report-${object.code.split('.').at(-1)}`);
    expect(
      (
        await setObjectPermission(
          world,
          profile,
          {
            dataOperations: { create: false, update: false, delete: false },
            fields: [],
            buttons: [],
          },
          object.code,
        )
      ).status,
    ).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, member.id, profile.id)).status).toBe(201);
    for (const report of reports) {
      expect((await myObject(world, member, report.code)).status).toBe(report.code === object.code ? 200 : 403);
    }
    const response = await snapshot(member.id);
    expect(response.apps.find((app) => app.app === 'staff')).toEqual({
      app: 'staff',
      visible: true,
      entryObjects: [object.code],
    });
    expect(menuNodes(registry.entries, response).map((menu) => menu.key)).toEqual(['reports']);
    expect(response.scope.find((scope) => scope.app === 'staff')).toMatchObject({
      status: 'none',
      organizationIds: [],
    });
  });
  it('无权普通成员：不返回报表对象，不显示入口，不扩大数据范围', async () => {
    const member = await addMember(world, 'report-none');
    const response = await snapshot(member.id);
    expect(response.apps.find((app) => app.app === 'staff')).toEqual({
      app: 'staff',
      visible: false,
      entryObjects: [],
    });
    expect(menuNodes(registry.entries, response)).toEqual([]);
    for (const report of reports) expect((await myObject(world, member, report.code)).status).toBe(403);
  });
});
