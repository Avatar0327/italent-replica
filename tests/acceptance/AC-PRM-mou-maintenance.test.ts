/**
 * 企业设置 · 管理单元维护（R1-T15；06 §7.1、§7.4；REQ-PRM-002 配置边界）。复用 R1-T02 的管理单元接口：
 * - 可见：持「管理单元」能力的租户 / 系统 / 用户 / 权限管理员都能查看列表与详情（06 §7.1）；
 * - 可操作：增删改首版只开放给租户管理员（REQ-PRM-002「配置边界」）；
 * - 引用检查：被用户授权的数据范围引用、或仍有下级的管理单元不能删除。
 */
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, BASE, type PermissionWorld, seedPermissionWorld } from './AC-PRM-support.js';
import { memberWithAdminRole, reasonOf } from './AC-PRM-users-support.js';

const testDb = useTestDb();

interface MouBody {
  id: string;
  code: string;
  status: string;
  revision: number;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

describe('管理单元维护：可见与可操作、引用检查', () => {
  let world: PermissionWorld;

  beforeAll(async () => {
    world = await seedPermissionWorld(testDb().db);
  });

  async function createMou(parentId: string | null = null): Promise<MouBody> {
    const res = await world.api.request('POST', `${BASE}/mous`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { code: `MOU_${randomUUID().slice(0, 8)}`, name: '华东管理单元', parentId, orgRanges: [] },
    });
    expect(res.status, await res.clone().text()).toBe(201);
    return (await res.json()) as MouBody;
  }

  const remove = (mou: MouBody, as = world.asAdmin) =>
    world.api.request('DELETE', `${BASE}/mous/${mou.id}`, { ...as, ifMatch: mou.revision });

  async function codes(as = world.asAdmin): Promise<string[]> {
    const res = await world.api.request('GET', `${BASE}/mous?limit=200`, as);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { items: MouBody[] }).items.map((m) => m.code);
  }

  it('系统 / 用户 / 权限管理员可查看，但不能新增、修改、删除；员工管理员看不到', async () => {
    const mou = await createMou();
    for (const role of ['system_admin', 'user_admin', 'permission_admin'] as const) {
      const admin = await memberWithAdminRole(world, role);
      expect(await codes(admin.as)).toContain(mou.code);
      const detail = await world.api.request('GET', `${BASE}/mous/${mou.id}`, admin.as);
      expect(detail.status).toBe(200);
      const created = await world.api.request('POST', `${BASE}/mous`, {
        ...admin.as,
        ifMatch: 0,
        body: { code: `X_${randomUUID().slice(0, 6)}`, name: '越权新增', orgRanges: [] },
      });
      expect(created.status).toBe(403);
      const updated = await world.api.request('PUT', `${BASE}/mous/${mou.id}`, {
        ...admin.as,
        ifMatch: mou.revision,
        body: { code: mou.code, name: '越权修改', orgRanges: [] },
      });
      expect(updated.status).toBe(403);
      expect((await remove(mou, admin.as)).status).toBe(403);
    }
    const employeeAdmin = await memberWithAdminRole(world, 'employee_admin');
    expect((await world.api.request('GET', `${BASE}/mous`, employeeAdmin.as)).status).toBe(403);
  });

  it('被用户数据范围引用的管理单元不能删除；改用其他范围后可以删除，删除写审计与 outbox', async () => {
    const mou = await createMou();
    const user = await addMember(world, 'mou-holder');
    const assign = (body: unknown, ifMatch: number) =>
      world.api.request('PUT', `${BASE}/scopes/${user.id}/TenantBase`, { ...world.asAdmin, ifMatch, body });
    expect((await assign({ kind: 'mou', mouId: mou.id }, 0)).status).toBe(200);

    expect(await reasonOf(await remove(mou))).toMatchObject({ status: 409, code: 'CONFLICT', reason: 'MOU_IN_USE' });
    expect(await codes()).toContain(mou.code);

    expect((await assign({ kind: 'default' }, 1)).status).toBe(200);
    const removed = await remove(mou);
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await removed.json()).toMatchObject({ status: 'deleted', revision: mou.revision + 1 });
    expect(await codes()).not.toContain(mou.code);

    const outbox = await withTenant(testDb().db, world.tenant.id, (tx) =>
      tx.execute(sql`SELECT event_type FROM permission_outbox WHERE object_id=${mou.id}`),
    );
    expect(rowsOf<{ event_type: string }>(outbox).map((r) => r.event_type)).toContain('permission_mou.change');
  });

  it('仍有下级管理单元的不能删除；已删除的管理单元不能再被引用', async () => {
    const parent = await createMou();
    const child = await createMou(parent.id);
    expect(await reasonOf(await remove(parent))).toMatchObject({ status: 409, reason: 'MOU_HAS_CHILDREN' });
    expect((await remove(child)).status).toBe(200);
    expect((await remove(parent)).status).toBe(200);

    const user = await addMember(world, 'deleted-mou');
    const assigned = await world.api.request('PUT', `${BASE}/scopes/${user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'mou', mouId: parent.id },
    });
    expect(assigned.status).toBe(404);
  });
});
