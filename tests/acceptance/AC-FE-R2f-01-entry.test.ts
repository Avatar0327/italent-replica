import { withTenant } from '@italent/db';
import { MODULE_OBJECTS, STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { installProfile } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { collectPages } from '../../apps/web/src/foundation/page-registry.js';
import { menuNodes, type ServerSnapshot } from '../../apps/web/src/foundation/permission-snapshot.js';
import {
  addMember,
  BASE,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
  type PermissionWorld,
} from './AC-PRM-support.js';
import { cmd } from './support/tenant-api.js';

const database = useTestDb();
const tabs = [
  MODULE_OBJECTS.hrDashboard,
  MODULE_OBJECTS.hrStructure,
  MODULE_OBJECTS.hrMovement,
  MODULE_OBJECTS.hrProcessDashboard,
].map((object) => object.code);
const contract = MODULE_OBJECTS.contractBoard.code;
const boards = [...tabs, contract];
const reports = [
  { id: 'fixture-roster', label: '员工名册', objectCode: MODULE_OBJECTS.hrRoster.code },
  { id: 'fixture-structure-reports', label: '员工结构', objectCode: MODULE_OBJECTS.hrStructureReport.code },
  { id: 'fixture-movement-reports', label: '流动情况', objectCode: MODULE_OBJECTS.hrMovementReport.code },
];

// 只在测试中声明入口，消费真实快照验证 §2 的分组契约。
const registry = collectPages(
  {
    '../fixture/pages.ts': {
      pages: {
        apps: [{ app: 'staff', label: '员工', group: 'people' }],
        entries: [
          {
            id: 'fixture-analytics',
            app: 'staff',
            group: 'people',
            label: '数据分析',
            children: [
              { id: 'fixture-dashboard', label: '人事看板', objectCodes: tabs },
              ...reports,
              { id: 'fixture-contract-board', label: '合同情况', objectCode: contract },
            ],
          },
        ],
      },
    },
  },
  ['staff'],
);

const dashboardPresets = ['standard_hr_dashboard_specialist', 'standard_hr_dashboard_manager'];
const hrAdmin = 'standard_hr_admin';
let world: PermissionWorld;
const presetIds = new Map<string, string>();

beforeAll(async () => {
  world = await seedPermissionWorld(database().db);
  const tenantId = world.tenant.id;
  const write = { tenantId, actorUserId: null, now: new Date(), commandId: cmd().commandId };
  await withTenant(world.db, tenantId, async (tx) => {
    for (const code of [...dashboardPresets, hrAdmin]) {
      const profile = STANDARD_PROFILES.find((preset) => preset.code === code)!;
      presetIds.set(code, (await installProfile(tx, write, profile)).id);
    }
  });
  await makeGrantable(world, [...presetIds.values()]);
});

async function snapshot(user: string) {
  const response = await world.api.request('GET', `${BASE}/me/snapshot`, { user, tenant: world.tenant.id });
  expect(response.status).toBe(200);
  return (await response.json()) as ServerSnapshot;
}

async function presetSnapshot(code: string) {
  const member = await addMember(world, code);
  expect((await grant(world, member.id, presetIds.get(code)!)).status).toBe(201);
  return snapshot(member.id);
}

const staff = (response: ServerSnapshot) => response.apps.find((app) => app.app === 'staff');

function expectAnalyticsChildren(response: ServerSnapshot, keys: string[]) {
  const menus = menuNodes(registry.entries, response);
  expect(menus.map((menu) => menu.key)).toEqual(['fixture-analytics']);
  expect(menus[0]?.children?.map((item) => item.key)).toEqual(keys);
}

describe('AC-FE-R2f-01 人事分析目录契约 /me 快照', () => {
  it.each(dashboardPresets)('纯看板预置身份 %s：staff 仅返回五个看板对象，分组只显示看板入口', async (code) => {
    const response = await presetSnapshot(code);
    expect(staff(response)?.visible).toBe(true);
    expect([...(staff(response)?.entryObjects ?? [])].sort()).toEqual([...boards].sort());
    expectAnalyticsChildren(response, ['fixture-dashboard', 'fixture-contract-board']);
  });

  it.each(boards)('单授 %s 查看权：staff 精确返回该对象，分组只显示对应入口', async (objectCode) => {
    const member = await addMember(world, 'analytics-reader');
    const profile = await createProfile(world, `analytics-${objectCode.split('.').at(-1)}`);
    const permission = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: [],
        buttons: [],
      },
      objectCode,
    );
    expect(permission.status).toBe(200);
    await makeGrantable(world, [profile.id]);
    expect((await grant(world, member.id, profile.id)).status).toBe(201);

    const response = await snapshot(member.id);
    expect(staff(response)).toEqual({ app: 'staff', visible: true, entryObjects: [objectCode] });
    expectAnalyticsChildren(response, [objectCode === contract ? 'fixture-contract-board' : 'fixture-dashboard']);
  });

  it('预置人事管理员：分析对象只有三项报表，分组只显示报表子项', async () => {
    const response = await presetSnapshot(hrAdmin);
    const reportCodes = reports.map((report) => report.objectCode).sort();
    const analyticsCodes = new Set([...boards, ...reportCodes]);
    expect(
      staff(response)
        ?.entryObjects.filter((code) => analyticsCodes.has(code))
        .sort(),
    ).toEqual(reportCodes);
    expectAnalyticsChildren(
      response,
      reports.map((report) => report.id),
    );
  });

  it('无授权成员：staff 不可见，空分组隐藏', async () => {
    const member = await addMember(world, 'analytics-unassigned');
    const response = await snapshot(member.id);
    expect(staff(response)).toEqual({ app: 'staff', visible: false, entryObjects: [] });
    expect(menuNodes(registry.entries, response)).toEqual([]);
  });
});
