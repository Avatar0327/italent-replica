/**
 * AC-HA-05 / AC-HA-13a-10 / AC-HA-13b-11（F-472，DEC-767、DEC-768、DEC-763②）：预置身份与人事看板的授权口径，走真实授权器。
 * - 人事管理员（standard_hr_admin）没有看板类对象：调人事看板 / 人员结构分析 / 合同情况 / 人员流动分析 / 人事流程看板接口一律 403
 *   （不是 200 空数据），授了数据范围也一样；
 * - 新增预置身份 HR 专员 / HR 经理：出厂带看板类授权对象并预置“看全部”，不配数据范围就能看全租户（含范围外部门）；
 * - 人事管理员的名册 / 结构类报表（员工结构报表 B53、流动情况报表 B54）保留查看，按管理单元（数据范围）取数：
 *   范围内人数 = 明细，范围外不出现，空范围 fail-closed（全 0、hasDataPermission = false，不退回“全部”）；
 * - 授权版本已升，回补报告（F-061）能列出新增 / 去掉的授权项。
 * 夹具：造数用放行授权器，被测请求一律走真实授权器（authorize: undefined）。
 */
import { readFileSync } from 'node:fs';
import { bootstrapTenantAdmin } from '@italent/api';
import { permissionAdminGrantableProfiles, permissionAdmins, withTenant } from '@italent/db';
import {
  CONTRACT_BOARD_OBJECT,
  HR_DASHBOARD_OBJECT,
  HR_MOVEMENT_OBJECT,
  HR_MOVEMENT_REPORT_OBJECT,
  HR_PROCESS_DASHBOARD_OBJECT,
  HR_STRUCTURE_OBJECT,
  HR_STRUCTURE_REPORT_OBJECT,
  presetSeeAllTargets,
  STANDARD_GRANT_CODES,
  STANDARD_GRANT_VERSION,
  STANDARD_PROFILES,
} from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { installProfileRows } from '../../apps/api/src/modules/permission/standard-profiles.js';
import { structureWorld, TODAY } from './AC-HA-13a-support.js';
import { legacyWorld, runBackfill, type World } from './support/f061.js';
import { holderOfProfile } from './support/ql-presets.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const AS_OF = `asOf=${TODAY}`;
const HR_ADMIN = 'standard_hr_admin';
const DASHBOARD_PROFILES = ['standard_hr_dashboard_specialist', 'standard_hr_dashboard_manager'];
const BOARD_OBJECTS = [
  HR_DASHBOARD_OBJECT,
  HR_PROCESS_DASHBOARD_OBJECT,
  HR_STRUCTURE_OBJECT,
  CONTRACT_BOARD_OBJECT,
  HR_MOVEMENT_OBJECT,
];
const REPORT_OBJECTS = [HR_STRUCTURE_REPORT_OBJECT, HR_MOVEMENT_REPORT_OBJECT];
const BASE = '/api/tenant/analytics';
const BOARDS = {
  dashboard: `${BASE}/hr-dashboard`,
  process: `${BASE}/hr-process-dashboard`,
  structure: `${BASE}/hr-structure`,
  contract: `${BASE}/contract-board`,
  movement: `${BASE}/hr-movement`,
};
/** 每个看板的概览与一个组件 / 指标明细入口，都要被拦。 */
const BOARD_PATHS = [
  `${BOARDS.dashboard}?${AS_OF}`,
  `${BOARDS.process}?${AS_OF}`,
  `${BOARDS.structure}?${AS_OF}`,
  `${BOARDS.structure}/components/6.01?${AS_OF}`,
  `${BOARDS.contract}?${AS_OF}`,
  `${BOARDS.contract}/components/3.1.17?${AS_OF}`,
  `${BOARDS.movement}?${AS_OF}`,
];

type Profile = (typeof STANDARD_PROFILES)[number];
const profile = (code: string): Profile => STANDARD_PROFILES.find((item) => item.code === code)!;
const objectCodes = (code: string) => profile(code).objects.map((item) => item.objectCode);
const seeAllTargets = (code: string) => presetSeeAllTargets(profile(code)).map((target) => target.targetCode);

async function buildWorld() {
  const w = await structureWorld(database().db, 'ha05-grants');
  const inside = await w.org('范围内部门');
  const outside = await w.org('范围外部门');
  // 入职在今年内，流动情况报表（B54 流入）才有数
  const hire = (name: string, department: { id: string }) => w.hire(name, { date: '2026-03-02', department });
  const people = {
    in1: await hire('范围内甲', inside),
    in2: await hire('范围内乙', inside),
    out: await hire('范围外', outside),
  };
  // 被测请求走真实授权器；租户管理员 = 造数用户（有权给成员授身份、配范围）
  const { db, tenantId } = w;
  await bootstrapTenantAdmin(db, { tenantId, userId: w.who.user }, cmd());
  const profileIds = new Map<string, string>();
  const write = { tenantId, actorUserId: null, now: new Date(), commandId: `ha05-${tenantId}` };
  await withTenant(db, tenantId, async (tx) => {
    for (const standard of STANDARD_PROFILES)
      profileIds.set(standard.code, (await installProfileRows(tx, write, standard)).id);
    // 造数用户 = 租户管理员，可授权全部标准身份（开通时下发的口径，同 provisioning）
    const [admin] = await tx.select().from(permissionAdmins);
    await tx
      .insert(permissionAdminGrantableProfiles)
      .values([...profileIds.values()].map((profileId) => ({ tenantId, adminId: admin!.id, profileId })));
  });
  const api = tenantApi(db, { authorize: undefined, clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const asAdmin = { user: w.who.user, tenant: tenantId };
  const kit: Pick<World, 'db' | 'api' | 'asAdmin' | 'profileIds'> = { db, api, asAdmin, profileIds };
  const holder = (code: string, label: string) => {
    expect(profileIds.has(code), `${code} 应是预置身份`).toBe(true);
    return holderOfProfile(kit, code, label);
  };
  /** 给持有人配“组织范围”数据范围（身份 × 应用一份，DEC-043）：管理单元 = 这些组织及下级。 */
  async function scopeTo(userId: string, orgIds: readonly string[]) {
    const path = `/api/tenant/permission/scopes/${userId}/TenantBase`;
    const current = await api.request('GET', path, asAdmin);
    const revision = Number(((await current.json()) as { revision?: number }).revision ?? 0);
    const put = await api.request('PUT', path, {
      ...asAdmin,
      ifMatch: revision,
      body: { kind: 'org_range', orgRanges: orgIds.map((orgId) => ({ orgId, includeDescendants: true })) },
    });
    expect(put.status, await put.clone().text()).toBe(200);
  }
  return { w, api, inside, outside, people, holder, scopeTo };
}
type World = Awaited<ReturnType<typeof buildWorld>>;

describe('F-472 预置身份与人事看板授权', () => {
  let x: World;
  beforeAll(async () => {
    x = await buildWorld();
  }, 300_000);

  const get = (who: { user: string; tenant: string }, path: string) => x.api.request('GET', path, who);
  const body = async <T>(who: { user: string; tenant: string }, path: string) => {
    const response = await get(who, path);
    expect(response.status, `${path} ${await response.clone().text()}`).toBe(200);
    return (await response.json()) as T;
  };

  it('预置授权：人事管理员没有看板类对象和看板类看全部；名册 / 结构类报表保留查看但不预置看全部', () => {
    for (const object of BOARD_OBJECTS) {
      expect(objectCodes(HR_ADMIN), `hr_admin ${object}`).not.toContain(object);
      expect(seeAllTargets(HR_ADMIN), `hr_admin 看全部 ${object}`).not.toContain(object);
      expect(objectCodes('standard_org_system_admin'), `管理员 ${object}`).toContain(object);
      expect(seeAllTargets('standard_org_system_admin'), `管理员看全部 ${object}`).toContain(object);
    }
    // 管理单元取数：报表对象仍可查看，但不是看全部
    for (const object of REPORT_OBJECTS) {
      expect(objectCodes(HR_ADMIN), `hr_admin ${object}`).toContain(object);
      expect(seeAllTargets(HR_ADMIN), `hr_admin 看全部 ${object}`).not.toContain(object);
    }
  });

  it('预置身份 HR 专员 / HR 经理：只带看板类对象（只读）并预置这五个对象的看全部，不占其它能力', () => {
    for (const code of DASHBOARD_PROFILES) {
      const preset = profile(code);
      expect(preset, code).toBeDefined();
      expect(preset.apps).toEqual(['TenantBase']);
      expect(objectCodes(code).sort(), code).toEqual([...BOARD_OBJECTS].sort());
      for (const object of preset.objects) {
        expect(object.dataOperations, `${code} ${object.objectCode}`).toEqual({
          create: false,
          update: false,
          delete: false,
        });
        expect(object.buttons, `${code} ${object.objectCode}`).toEqual([]);
      }
      expect(seeAllTargets(code).sort(), code).toEqual([...BOARD_OBJECTS].sort());
    }
    expect(profile(DASHBOARD_PROFILES[0]!).name).toBe('HR专员（人事看板）');
    expect(profile(DASHBOARD_PROFILES[1]!).name).toBe('HR经理（人事看板）');
  });

  it('AC-HA-05：人事管理员调各看板接口 → 403（不是 200 空数据），授了管理单元范围也一样', async () => {
    const hr = await x.holder(HR_ADMIN, 'ha05-hr-admin');
    await x.scopeTo(hr.user, [x.inside.id]);
    for (const path of BOARD_PATHS) expect((await get(hr, path)).status, path).toBe(403);
  });

  it('AC-HA-05：HR 专员 / HR 经理不配数据范围也看全部看板（含范围外部门），数字 = 全租户', async () => {
    for (const code of DASHBOARD_PROFILES) {
      const who = await x.holder(code, `ha05-${code}`);
      const structure = await body<{
        hasDataPermission: boolean;
        components: { code: string; value: number | null }[];
      }>(who, `${BOARDS.structure}?${AS_OF}`);
      expect(structure.hasDataPermission, code).toBe(true);
      expect(structure.components.find((item) => item.code === '6.01')!.value, `${code} 人数含范围外`).toBe(3);
      const detail = await body<{ items: { id: string }[]; total: number }>(
        who,
        `${BOARDS.structure}/components/6.01?${AS_OF}&pageSize=10`,
      );
      expect(detail.items.map((item) => item.id).sort(), code).toEqual(
        [x.people.in1.id, x.people.in2.id, x.people.out.id].sort(),
      );
      for (const path of [BOARDS.dashboard, BOARDS.process, BOARDS.contract, BOARDS.movement])
        expect((await get(who, `${path}?${AS_OF}`)).status, `${code} ${path}`).toBe(200);
      // 看板类授权对象只读：名册 / 结构类报表对象不在这两个身份里
      expect((await get(who, `${BOARDS.structure}/reports/quality?${AS_OF}`)).status, `${code} 报表`).toBe(403);
    }
  });

  it('AC-HA-05：人事管理员员工结构报表（B53）、流动情况报表（B54）按管理单元取数——人数 = 范围内，范围外不出现', async () => {
    const hr = await x.holder(HR_ADMIN, 'ha05-hr-reports');
    await x.scopeTo(hr.user, [x.inside.id]);
    const position = await body<{
      hasDataPermission: boolean;
      rows: { organizationId: string }[];
      summary: { cells: Record<string, number | null> };
    }>(hr, `${BOARDS.structure}/reports/quality?${AS_OF}`);
    expect(position.hasDataPermission).toBe(true);
    expect(position.rows.map((row) => row.organizationId)).toEqual([x.inside.id]);
    expect(position.summary.cells).toMatchObject({ total: 2 });

    const inflow = await body<{
      hasDataPermission: boolean;
      tables: { key: string; summary: { cells: Record<string, number> } }[];
    }>(hr, `${BOARDS.movement}/reports/inflow?${AS_OF}`);
    expect(inflow.hasDataPermission).toBe(true);
    expect(inflow.tables.find((table) => table.key === 'inflow')!.summary.cells).toMatchObject({ total: 2 });
  });

  it('AC-HA-05：人事管理员没有配数据范围 → 报表 fail-closed（全 0、hasDataPermission = false），不是看全部', async () => {
    const hr = await x.holder(HR_ADMIN, 'ha05-hr-empty');
    const position = await body<{ hasDataPermission: boolean; rows: unknown[] }>(
      hr,
      `${BOARDS.structure}/reports/quality?${AS_OF}`,
    );
    expect({ rows: position.rows, permission: position.hasDataPermission }).toEqual({ rows: [], permission: false });
    const inflow = await body<{ hasDataPermission: boolean; tables: { summary: { cells: Record<string, number> } }[] }>(
      hr,
      `${BOARDS.movement}/reports/inflow?${AS_OF}`,
    );
    expect(inflow.hasDataPermission).toBe(false);
    expect(inflow.tables.every((table) => (table.summary.cells.total ?? 0) === 0)).toBe(true);
  });

  it('AC-HA-05：管理员（standard_org_system_admin）仍有看板类对象与看全部', async () => {
    const admin = await x.holder('standard_org_system_admin', 'ha05-sys-admin');
    const structure = await body<{ components: { code: string; value: number | null }[] }>(
      admin,
      `${BOARDS.structure}?${AS_OF}`,
    );
    expect(structure.components.find((item) => item.code === '6.01')!.value).toBe(3);
  });
});

describe('F-472 授权版本与回补报告（DEC-439④）', () => {
  const declared = JSON.parse(
    readFileSync(new URL('../../packages/domain/src/platform/standard-grant-changes.json', import.meta.url), 'utf8'),
  ) as { reason: string; add: string[]; remove: string[] };

  it('授权版本已升（F-323 为 43），变更声明写明新增：两个新身份整体；去掉：人事管理员的看板类对象与看全部', () => {
    expect(STANDARD_GRANT_VERSION).toBeGreaterThan(43);
    expect(declared.reason).toContain('F-472');
    for (const code of DASHBOARD_PROFILES)
      expect(
        declared.add.some((entry) => entry.startsWith(`${code}/`)),
        `新增 ${code}`,
      ).toBe(true);
    for (const object of BOARD_OBJECTS)
      expect(
        declared.remove.some((entry) => entry.startsWith(`${HR_ADMIN}/${object}`)),
        `去掉 ${HR_ADMIN}/${object}`,
      ).toBe(true);
    // 人事管理员的名册 / 结构类报表对象不在去掉之列（按管理单元继续可看）
    for (const object of REPORT_OBJECTS)
      expect(declared.remove.some((entry) => entry.includes(`/${object}/op:view`))).toBe(false);
  });

  it('授权项编码：新身份的对象查看与看全部都有编码；人事管理员的看板类对象 / 看全部编码已不在', () => {
    for (const code of DASHBOARD_PROFILES)
      for (const object of BOARD_OBJECTS) {
        expect(STANDARD_GRANT_CODES, `${code} ${object} 查看`).toContain(`${code}/${object}/op:view`);
        expect(STANDARD_GRANT_CODES, `${code} ${object} 看全部`).toContain(
          `${code}/seeAll:TenantBase:entity:${object}`,
        );
      }
    for (const object of BOARD_OBJECTS) {
      expect(STANDARD_GRANT_CODES).not.toContain(`${HR_ADMIN}/${object}/op:view`);
      expect(STANDARD_GRANT_CODES).not.toContain(`${HR_ADMIN}/seeAll:TenantBase:entity:${object}`);
    }
    for (const object of REPORT_OBJECTS) expect(STANDARD_GRANT_CODES).toContain(`${HR_ADMIN}/${object}/op:view`);
  });

  it('回补：缺这两个新身份的存量租户，回补报告的身份项列出它们已安装', async () => {
    const w = await legacyWorld(database().db, 'f472-backfill', [], DASHBOARD_PROFILES);
    const report = await runBackfill(w);
    for (const code of DASHBOARD_PROFILES) expect(report.items[0]!.installed, code).toContain(code);
  });
});
