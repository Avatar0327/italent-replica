/**
 * PR #75 第三轮（DEC-197 的剩余分支，真实授权器）：
 * - P1-1：缺少归属的人员类日志（升级前只存变化字段、或归属推导失败）不能退化为“有数据权限就可读”；
 *   员工信息按对象 ID 取所属人员，推导不出归属的按 fail-closed 处理；
 * - P1-2：跨人员 / 组织的任务日志按每一行的归属判断：全部在范围外的任务不返回，部分在范围内的只返回范围内的行，
 *   汇总（条数、文案）也只按范围内的行计算，错误报告不含范围外的行；
 * - P1-3：编制方案、组织编码预占等有独立业务权限规则的对象复用业务规则——业务接口拒绝时，审计接口也不能绕过；
 *   真正的配置对象（DEC-203）持日志审计即可见，合同主数据（合同类型等）同属配置；
 * - P2-1：“使用用户（创建人）”范围按保留的创建人元数据（DEC-198）判断：本人创建的可见、他人创建的不可见，
 *   创建日志被保留期清理后结果不变。
 */
import { randomUUID } from 'node:crypto';
import { type Db, insertAuditEvent, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, SUBSETS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { runAuditRetention } from '@italent/api';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  type PermissionWorld,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const ORG = MODULE_OBJECTS.organization;
const PERSON = { code: PERSONNEL_OBJECT };
const EDUCATION = { code: SUBSETS.education.objectCode };

type Who = { user: string; tenant: string };

async function profileFor(world: PermissionWorld, objects: { code: string; fields: readonly string[] }[]) {
  const profile = await createProfile(world, `aud-r3-${randomUUID().slice(0, 8)}`);
  for (const { code, fields } of objects) {
    const response = await setObjectPermission(
      world,
      profile,
      {
        dataOperations: { create: false, update: false, delete: false },
        fields: fields.map((fieldCode) => ({ fieldCode, view: true, edit: false })),
        buttons: [],
      },
      code,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  return profile;
}

async function viewerWith(
  world: PermissionWorld,
  label: string,
  objects: { code: string; fields: readonly string[] }[],
  orgRange?: string,
) {
  const viewer = await memberWithAdminRole(world, 'audit_admin', label);
  const profile = await profileFor(world, objects);
  expect((await grant(world, viewer.user.id, profile.id)).status).toBe(201);
  if (orgRange) {
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${viewer.user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: orgRange, includeDescendants: true }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
  }
  return viewer;
}

async function fixture() {
  const db = database().db;
  const world = await seedPermissionWorld(db);
  const setup = tenantApi(db, { clock: () => new Date(NOW) });
  async function call(method: string, path: string, body: unknown, revision?: number, key?: string) {
    const response = await setup.request(method, `/api/tenant/${path}`, {
      ...world.asAdmin,
      ifMatch: revision,
      body,
      ...(key ? { idempotencyKey: key } : {}),
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return (await response.json()) as { id: string; revision: number; employeeRevision?: number };
  }
  const org = (name: string) =>
    call(
      'POST',
      'org/organizations',
      { name, establishedOn: '2025-01-01', parents: { admin: { parentId: world.tenant.id } } },
      0,
    );
  const inside = await org('第三轮范围内部门');
  const outside = await org('第三轮范围外部门');
  async function hired(departmentId: string) {
    const employee = await call('POST', 'employment/employees', { code: `E_${randomUUID()}`, name: '合成员工' }, 0);
    await call(
      'POST',
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId },
        loginEmail: loginEmailOf(employee.id),
      },
      employee.revision,
    );
    return employee;
  }
  const mine = await hired(inside.id);
  const theirs = await hired(outside.id);
  const viewer = await viewerWith(
    world,
    'aud-r3-viewer',
    [
      { code: PERSON.code, fields: ['gender'] },
      { code: EDUCATION.code, fields: ['school'] },
      { code: ORG.code, fields: ORG.fields.map((field) => field.code) },
    ],
    inside.id,
  );
  const auditOnly = await memberWithAdminRole(world, 'audit_admin', 'aud-r3-only');
  return { db, world, setup, call, inside, outside, mine, theirs, viewer, auditOnly };
}

/** 按升级前 / 推导失败的形状直接写审计行（只有变化字段，没有所属人员）。 */
async function rawEvent(
  db: Db,
  world: PermissionWorld,
  entry: { action: string; objectType: string; objectId: string; before: unknown; after: unknown; at?: string },
  actorUserId: string = world.admin.id,
) {
  await withTenant(db, world.tenant.id, (tx) =>
    insertAuditEvent(tx, {
      tenantId: world.tenant.id,
      actorUserId,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      before: entry.before,
      after: entry.after,
      occurredAt: new Date(entry.at ?? NOW),
    }),
  );
}

async function auditIdsOf(db: Db, tenantId: string, objectId: string): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT id FROM audit_events WHERE object_id=${objectId} ORDER BY occurred_at`);
    return ((Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[]).map(
      (row) => row.id,
    );
  });
}

describe('PR #75 第三轮：审计查询复用业务权限规则', () => {
  let w: Awaited<ReturnType<typeof fixture>>;
  const audit = (db: Db) => auditApi(db, NOW, { authorize: undefined });
  beforeAll(async () => {
    w = await fixture();
  });

  it('P1-1 员工信息日志只存变化字段（没有 employeeId）：按对象 ID 归属，范围外不返回、详情 404', async () => {
    for (const employee of [w.mine, w.theirs]) {
      await rawEvent(w.db, w.world, {
        action: 'personnel.update',
        objectType: PERSON.code,
        objectId: employee.id,
        before: { gender: '男' },
        after: { gender: '女' },
      });
    }
    const { items } = await audit(w.db).dataChanges(w.viewer.as, { objectType: PERSON.code, limit: '100' });
    const objects = items.map((item) => item.objectId);
    expect(objects).toContain(w.mine.id);
    expect(objects).not.toContain(w.theirs.id);
    const theirsLogs = await withTenant(w.db, w.world.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT id FROM audit_events
        WHERE object_type=${PERSON.code} AND object_id=${w.theirs.id}`);
      return (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[];
    });
    expect(theirsLogs).toHaveLength(1);
    expect((await audit(w.db).get(`/data-changes/${theirsLogs[0]!.id}`, w.viewer.as)).status).toBe(404);
  });

  it('P1-1 归属推导失败（子集记录查不到所属人员）按 fail-closed：有数据权限也不返回、详情 404', async () => {
    const orphan = randomUUID();
    await rawEvent(w.db, w.world, {
      action: 'personnel.update',
      objectType: EDUCATION.code,
      objectId: orphan,
      before: { school: '旧学校' },
      after: { school: '新学校' },
    });
    expect((await audit(w.db).dataChanges(w.viewer.as, { objectId: orphan })).items).toEqual([]);
    const [id] = await auditIdsOf(w.db, w.world.tenant.id, orphan);
    expect((await audit(w.db).get(`/data-changes/${id}`, w.viewer.as)).status).toBe(404);
  });

  it('P1-2 组织导入任务：全部在范围外不返回；部分在范围内只按范围内的行汇总，错误报告不含范围外的行', async () => {
    const outsideOnly = randomUUID();
    await w.call(
      'POST',
      'org/import',
      { rows: [{ sourceCode: 'S-OUT-1', code: 'OUTSIDE_CODE', name: '范围外导入部门', parentId: w.outside.id }] },
      0,
      outsideOnly,
    );
    const mixed = randomUUID();
    await w.call(
      'POST',
      'org/import',
      {
        rows: [
          { sourceCode: 'S-IN-1', code: 'INSIDE_CODE', name: '范围内导入部门', parentId: w.inside.id },
          { sourceCode: 'S-OUT-2', code: 'OUTSIDE_CODE', name: '范围外冲突部门', parentId: w.outside.id },
        ],
      },
      0,
      mixed,
    );
    const api = audit(w.db);
    expect((await api.operationLogs(w.viewer.as, { behavior: 'import', commandId: outsideOnly })).items).toEqual([]);
    const { items } = await api.operationLogs(w.viewer.as, { behavior: 'import', commandId: mixed });
    expect(items).toEqual([
      expect.objectContaining({ totalCount: 1, successCount: 1, failureCount: 0, result: 'succeeded' }),
    ]);
    expect(JSON.stringify(items)).not.toContain('OUTSIDE_CODE');
    expect(JSON.stringify(items)).not.toContain('S-OUT-2');
    // 逐行回执的数据变更日志同样按行归属裁剪
    const rows = await api.dataChanges(w.viewer.as, { objectType: 'org_import_result', limit: '100' });
    expect(JSON.stringify(rows.items)).not.toContain('OUTSIDE_CODE');
    expect(rows.items.some((item) => JSON.stringify(item).includes('INSIDE_CODE'))).toBe(true);
    // 看全部的查看人（租户管理员经可信端口）两条任务都能看到原始汇总
    const full = await auditApi(w.db, NOW).operationLogs(w.world.asAdmin, { behavior: 'import', commandId: mixed });
    expect(full.items).toEqual([expect.objectContaining({ totalCount: 2, successCount: 1, failureCount: 1 })]);
  });

  it('P1-3 编制方案：业务接口 403 的查看人，审计里也看不到方案日志', async () => {
    const scheme = await w.call(
      'POST',
      'establishment/schemes',
      { name: '第三轮编制方案', periodType: 'annual', maintenanceMode: 'inclusive', startDate: '2026-01-01' },
      0,
    );
    const business = tenantApi(w.db, { authorize: undefined, clock: () => new Date(NOW) });
    expect(
      (await business.request('GET', `/api/tenant/establishment/schemes/${scheme.id}`, w.auditOnly.as)).status,
    ).toBe(403);
    expect((await audit(w.db).dataChanges(w.auditOnly.as, { objectId: scheme.id })).items).toEqual([]);
    expect((await audit(w.db).dataChanges(w.viewer.as, { objectType: 'establishment-scheme' })).items).toEqual([]);
  });

  it('P1-3 组织编码预占：业务上只有看全部才可操作，按组织范围查看的人看不到', async () => {
    const reservation = await w.call('POST', 'org/code-reservations', {}, 0);
    expect(reservation.id).toBeDefined();
    const logs = await audit(w.db).dataChanges(w.viewer.as, { objectType: 'org_code_reservation', limit: '100' });
    expect(logs.items).toEqual([]);
    expect(
      (await audit(w.db).dataChanges(w.auditOnly.as, { objectType: 'org_code_reservation', limit: '100' })).items,
    ).toEqual([]);
  });

  it('DEC-203 合同主数据（合同类型等）与租户成员属于配置对象：持日志审计即可见', async () => {
    const typeId = randomUUID();
    await rawEvent(w.db, w.world, {
      action: 'contract.types.save',
      objectType: 'TenantBase.EmploymentContract',
      objectId: typeId,
      before: null,
      after: { code: 'labor', name: '劳动合同' },
    });
    expect((await audit(w.db).dataChanges(w.auditOnly.as, { objectId: typeId })).items).toHaveLength(1);
    const members = await audit(w.db).dataChanges(w.auditOnly.as, { objectType: 'tenant_membership', limit: '1' });
    expect(members.items.length).toBeGreaterThan(0);
  });

  it('P2-1 “使用用户”范围：本人创建的组织日志可见、他人创建的不可见；创建日志被保留期清理后结果不变', async () => {
    const creator = await viewerWith(w.world, 'aud-r3-creator', [
      { code: ORG.code, fields: ORG.fields.map((field) => field.code) },
    ]);
    const policy = await w.world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${ORG.code}/entity/${ORG.code}`,
      { ...w.world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    const own = randomUUID();
    const others = randomUUID();
    const old = '2025-01-01T01:00:00.000Z';
    await rawEvent(
      w.db,
      w.world,
      {
        action: 'org.create',
        objectType: 'organization',
        objectId: own,
        before: null,
        after: { name: '本人部门' },
        at: old,
      },
      creator.user.id,
    );
    await rawEvent(w.db, w.world, {
      action: 'org.create',
      objectType: 'organization',
      objectId: others,
      before: null,
      after: { name: '他人部门' },
      at: old,
    });
    for (const id of [own, others]) {
      await rawEvent(w.db, w.world, {
        action: 'org.update',
        objectType: 'organization',
        objectId: id,
        before: { name: '旧名' },
        after: { name: '新名' },
      });
    }
    const visible = async () =>
      (await audit(w.db).dataChanges(creator.as, { objectType: 'organization', limit: '100' })).items.map(
        (item) => item.objectId,
      );
    const before = await visible();
    expect(before).toContain(own);
    expect(before).not.toContain(others);

    await runAuditRetention(w.db, cmd(), { tenantId: w.world.tenant.id }, { clock: () => new Date(NOW) });
    expect(await auditIdsOf(w.db, w.world.tenant.id, own)).toHaveLength(1);
    const after = await visible();
    expect(after).toContain(own);
    expect(after).not.toContain(others);
  });

  it('普通成员仍没有日志审计入口', async () => {
    const plain = await addMember(w.world, 'aud-r3-plain');
    const as: Who = { user: plain.id, tenant: w.world.tenant.id };
    expect((await audit(w.db).get('/data-changes', as)).status).toBe(403);
  });
});
