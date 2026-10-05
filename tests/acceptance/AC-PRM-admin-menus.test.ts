/**
 * 8 类企业管理员身份 × 企业设置菜单（R1-T15；06 §7.1，G-008；官方《各个企业管理员身份权限对比》）。
 * 期望值直接读证据导出 `docs/01_证据/导出/企业管理员_8类身份菜单矩阵_官方.tsv`（67 行），逐个身份比对可见菜单。
 * 可操作：已实现的菜单按后端写接口的能力判定（如管理单元的增删改首版只给租户管理员，REQ-PRM-002 配置边界）；
 * 未实现的菜单只保留入口定义（OPEN-007、需取证项），不可操作。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AdminRole } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';

const testDb = useTestDb();

const TSV = fileURLToPath(new URL('../../docs/01_证据/导出/企业管理员_8类身份菜单矩阵_官方.tsv', import.meta.url));
const COLUMNS: readonly AdminRole[] = [
  'tenant_admin',
  'system_admin',
  'employee_admin',
  'user_admin',
  'permission_admin',
  'matrix_admin',
  'audit_admin',
  'billing_admin',
];

function officialMatrix(): Map<AdminRole, string[]> {
  const [, ...rows] = readFileSync(TSV, 'utf8').trim().split('\n');
  const matrix = new Map<AdminRole, string[]>(COLUMNS.map((role) => [role, []]));
  for (const row of rows) {
    const [group, name, ...marks] = row.split('\t').map((cell) => cell.trim());
    const path = name === '--' ? group! : `${group}/${name}`;
    COLUMNS.forEach((role, index) => {
      if (marks[index] === '√') matrix.get(role)!.push(path);
    });
  }
  return matrix;
}

interface MenuItem {
  code: string;
  path: string;
  implemented: boolean;
  editable: boolean;
}

describe('8 类企业管理员身份的企业设置菜单权责（06 §7.1）', () => {
  let world: PermissionWorld;
  const expected = officialMatrix();

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  async function menusOf(as: { user: string; tenant: string }): Promise<MenuItem[]> {
    const res = await world.api.request('GET', `${BASE}/admin-menus`, as);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { items: MenuItem[] }).items;
  }

  it('官方矩阵共 67 行；每类管理员可见的菜单与矩阵逐行一致', async () => {
    expect(expected.get('tenant_admin')).toHaveLength(67);
    expect((await menusOf(world.asAdmin)).map((m) => m.path).sort()).toEqual([...expected.get('tenant_admin')!].sort());
    for (const role of COLUMNS.filter((r) => r !== 'tenant_admin')) {
      const admin = await memberWithAdminRole(world, role);
      const visible = (await menusOf(admin.as)).map((m) => m.path).sort();
      expect(visible, role).toEqual([...expected.get(role)!].sort());
    }
  });

  it('不持管理员身份的成员看不到任何企业设置菜单；多身份取并集', async () => {
    const plain = await addMember(world, 'no-admin');
    expect(await menusOf({ user: plain.id, tenant: world.tenant.id })).toEqual([]);

    const both = await memberWithAdminRole(world, 'audit_admin', 'audit-and-billing');
    const res = await world.api.request('POST', `${BASE}/admins`, {
      ...world.asAdmin,
      body: { userId: both.user.id, role: 'billing_admin', grantableAdminRoles: [], grantableProfileIds: [] },
    });
    expect(res.status).toBe(201);
    const union = new Set([...expected.get('audit_admin')!, ...expected.get('billing_admin')!]);
    expect((await menusOf(both.as)).map((m) => m.path).sort()).toEqual([...union].sort());
  });

  it('可操作：管理单元对系统管理员只读、对租户管理员可维护；余额只读；未实现的菜单不可操作', async () => {
    const byPath = (items: MenuItem[]) => new Map(items.map((m) => [m.path, m]));
    const tenant = byPath(await menusOf(world.asAdmin));
    const system = byPath(await menusOf((await memberWithAdminRole(world, 'system_admin', 'sys-ops')).as));

    expect(tenant.get('权限管理/管理单元')).toMatchObject({ implemented: true, editable: true });
    expect(system.get('权限管理/管理单元')).toMatchObject({ implemented: true, editable: false });
    expect(system.get('用户管理/内部员工')).toMatchObject({ implemented: true, editable: true });
    expect(system.get('权限管理/用户授权')).toMatchObject({ implemented: true, editable: true });
    expect(system.get('许可管理/余额')).toMatchObject({ implemented: true, editable: false });
    expect(tenant.get('许可管理/余额分配组')).toMatchObject({ implemented: false, editable: false });
    expect(tenant.get('企业安全/字段加密设置')).toMatchObject({ implemented: false, editable: false });
  });
});
