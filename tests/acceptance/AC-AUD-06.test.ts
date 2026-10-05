/**
 * AC-AUD-06（docs/02_业务建模/20 §1、§5 第 5 条；06 §7.1 8 类管理员矩阵；REQ-AUD-001 R5）：
 * 系统管理员打开日志审计 → 不可见（A0 实测）；只有租户管理员、审计管理员可见、可查询。
 * 后端每次请求重新校验管理员身份（AGENTS.md §10「权限」）：菜单可见 ⇔ 接口可读；撤销审计管理员后立即 403。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { auditApi } from './AC-AUD-support.js';

const testDb = useTestDb();
const AUDIT_PATHS = ['/data-changes', '/operation-logs', '/command-failures'] as const;

interface MenuItem {
  code: string;
  path: string;
  implemented: boolean;
  editable: boolean;
}

describe('AC-AUD-06 日志审计的可见性', () => {
  let world: PermissionWorld;
  let audit: ReturnType<typeof auditApi>;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
    audit = auditApi(world.db, () => new Date(), { authorize: undefined });
  });

  async function menusOf(as: { user: string; tenant: string }): Promise<MenuItem[]> {
    const res = await world.api.request('GET', `${BASE}/admin-menus`, as);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: MenuItem[] }).items;
  }

  it('系统管理员：看不到「日志审计」，三个审计查询接口一律 403', async () => {
    const system = await memberWithAdminRole(world, 'system_admin', 'aud06-system');
    expect((await menusOf(system.as)).filter((menu) => menu.path.startsWith('日志审计/'))).toEqual([]);
    for (const path of AUDIT_PATHS) expect((await audit.get(path, system.as)).status, path).toBe(403);
  });

  it('不持管理员身份的成员同样 403；其他管理员（员工 / 用户 / 权限 / 矩阵 / 计费）也看不到', async () => {
    const plain = await addMember(world, 'aud06-plain');
    for (const path of AUDIT_PATHS) {
      expect((await audit.get(path, { user: plain.id, tenant: world.tenant.id })).status).toBe(403);
    }
    for (const role of ['employee_admin', 'user_admin', 'permission_admin', 'matrix_admin', 'billing_admin'] as const) {
      const admin = await memberWithAdminRole(world, role, `aud06-${role}`);
      expect((await audit.get('/data-changes', admin.as)).status, role).toBe(403);
    }
  });

  it('租户管理员、审计管理员：「日志审计/业务操作日志」可见且已实现（只读），接口可查', async () => {
    const auditor = await memberWithAdminRole(world, 'audit_admin', 'aud06-auditor');
    for (const as of [world.asAdmin, auditor.as]) {
      const business = (await menusOf(as)).find((menu) => menu.path === '日志审计/业务操作日志');
      expect(business).toMatchObject({ implemented: true, editable: false });
      for (const path of AUDIT_PATHS) expect((await audit.get(path, as)).status, path).toBe(200);
    }
    // 原站「日志审计」其余子菜单尚无取证（G-043），只保留入口定义
    const login = (await menusOf(auditor.as)).find((menu) => menu.path === '日志审计/登录日志');
    expect(login).toMatchObject({ implemented: false, editable: false });
  });

  it('审计管理员可以看到租户管理员授权留下的数据变更日志；撤销身份后立即 403', async () => {
    const auditor = await memberWithAdminRole(world, 'audit_admin', 'aud06-revoked');
    const { items } = await audit.dataChanges(auditor.as, { objectType: 'permission_admin', limit: '100' });
    expect(items.some((item) => item.operation === 'create' && item.operator.userId === world.admin.id)).toBe(true);

    // 管理员记录没有撤销接口（R1-T15 未提供），这里在租户路径上直接把记录置为撤销，验证每次请求都重验身份
    await withTenant(world.db, world.tenant.id, (tx) =>
      tx.execute(sql`UPDATE permission_admins SET status='revoked'
        WHERE user_id=${auditor.user.id}::uuid AND role='audit_admin'`),
    );
    expect((await audit.get('/data-changes', auditor.as)).status).toBe(403);
  });
});
