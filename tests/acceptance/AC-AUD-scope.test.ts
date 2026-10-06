/**
 * PR #75 第二轮 P1-1 / DEC-197：审计查询按查看人**当前**的数据范围（对象所属人员 / 组织）与字段权限裁剪，
 * 不设全量读取特权。持有「日志审计」只代表能进入查询；范围外对象不返回，隐藏字段不出现在差异、渲染文本、
 * 前后值与快照里，全部在分页前完成（字段筛选不能用来探测隐藏字段）。
 * 没有人员 / 组织归属的配置对象（权限、管理员等）按对应的企业设置能力判断（持有该能力才可见）。
 */
import { randomUUID } from 'node:crypto';
import { type Db, sql, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { memberWithAdminRole } from './AC-PRM-users-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
import { auditApi } from './AC-AUD-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const VISIBLE_FIELDS = ['id', 'employeeId', 'revision', 'effectiveDate', 'kind', 'status', 'departmentId', 'place'];

async function fixture() {
  const db = database().db;
  const world = await seedPermissionWorld(db);
  const setup = tenantApi(db, { clock: () => new Date(NOW) });
  async function call(method: string, path: string, body: unknown, revision?: number) {
    const response = await setup.request(method, `/api/tenant/${path}`, { ...world.asAdmin, ifMatch: revision, body });
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
  const inside = await org('审计范围内部门');
  const outside = await org('审计范围外部门');
  async function hired(departmentId: string) {
    const employee = await call('POST', 'employment/employees', { code: `E_${randomUUID()}`, name: '合成员工' }, 0);
    const hire = await call(
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
    return { employee, hire };
  }
  const mine = await hired(inside.id);
  const theirs = await hired(outside.id);
  const edited = await call(
    'PATCH',
    `employment/records/${mine.hire.id}`,
    { fields: { place: '可见地点', remarks: '隐藏备注甲' } },
    mine.hire.revision,
  );
  const remarksOnly = await call(
    'PATCH',
    `employment/records/${mine.hire.id}`,
    { fields: { remarks: '隐藏备注乙' } },
    edited.revision,
  );
  await call(
    'PATCH',
    `employment/records/${theirs.hire.id}`,
    { fields: { place: '范围外地点' } },
    theirs.hire.revision,
  );

  const viewer = await memberWithAdminRole(world, 'audit_admin', 'aud-scope-viewer');
  const profile = await createProfile(world, 'audit-employment-reader');
  for (const [code, fields] of [
    ['TenantBase.Employee', ['id', 'code', 'revision', 'status']],
    [MODULE_OBJECTS.employmentRecord.code, VISIBLE_FIELDS],
  ] as const) {
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
    expect(response.status).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, viewer.user.id, profile.id)).status).toBe(201);
  const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${viewer.user.id}/TenantBase`, {
    ...world.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: inside.id, includeDescendants: false }] },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const auditOnly = await memberWithAdminRole(world, 'audit_admin', 'aud-scope-only');
  const plain = await addMember(world, 'aud-scope-plain');
  return {
    db,
    world,
    mine,
    theirs,
    remarksOnly,
    viewer,
    auditOnly,
    plain,
    audit: auditApi(db, NOW, { authorize: undefined }),
  };
}

describe('DEC-197 审计查询按当前数据范围与字段权限裁剪', () => {
  let w: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    w = await fixture();
  });

  it('仅持审计管理员身份、没有任职对象权限与数据范围：看不到任何任职日志，详情 404', async () => {
    const { items } = await w.audit.dataChanges(w.auditOnly.as, { objectType: 'employment-record', limit: '100' });
    expect(items).toEqual([]);
    const [one] = await auditIds(w.db, w.world.tenant.id, w.mine.hire.id);
    expect((await w.audit.get(`/data-changes/${one}`, w.auditOnly.as)).status).toBe(404);
  });

  it('范围外人员的日志不返回；范围内照常返回', async () => {
    const { items } = await w.audit.dataChanges(w.viewer.as, { objectType: 'employment-record', limit: '100' });
    const objects = new Set(items.map((item) => item.objectId));
    expect(objects.has(w.mine.hire.id)).toBe(true);
    expect(objects.has(w.theirs.hire.id)).toBe(false);
    expect(items.some((item) => item.content.includes('范围外地点'))).toBe(false);
  });

  it('隐藏字段不出现在差异、渲染文本、前后值里；只改了隐藏字段的那次编辑整条不返回', async () => {
    const { items } = await w.audit.dataChanges(w.viewer.as, {
      objectId: w.mine.hire.id,
      action: 'employment.record.edit',
    });
    expect(items).toHaveLength(1);
    const [log] = items;
    expect(log!.content).toContain('工作地点:从【】修改为【可见地点】');
    expect(log!.content).not.toContain('隐藏备注');
    expect(log!.changes.map((change) => change.field)).not.toContain('remarks');
    const detail = await w.audit.dataChange(w.viewer.as, log!.id);
    expect(JSON.stringify(detail)).not.toContain('隐藏备注');
    expect(detail.after).not.toHaveProperty('remarks');
    // 字段筛选不能用来探测隐藏字段
    expect((await w.audit.dataChanges(w.viewer.as, { objectId: w.mine.hire.id, field: 'remarks' })).items).toEqual([]);
    // 库里确有两次编辑（第二次只改隐藏字段）
    expect(await auditIds(w.db, w.world.tenant.id, w.mine.hire.id, 'employment.record.edit')).toHaveLength(2);
  });

  it('配置对象按企业设置能力判断：租户管理员能看管理员变更，只持审计身份的看不到', async () => {
    // 管理员记录经权限接口按真实时钟写入，这里也按真实时钟查询
    const live = auditApi(w.db, () => new Date(), { authorize: undefined });
    const admin = await live.dataChanges(w.world.asAdmin, { objectType: 'permission_admin', limit: '100' });
    expect(admin.items.length).toBeGreaterThan(0);
    const auditor = await live.dataChanges(w.auditOnly.as, { objectType: 'permission_admin', limit: '100' });
    expect(auditor.items).toEqual([]);
  });

  it('普通成员没有日志审计入口：403', async () => {
    expect((await w.audit.get('/data-changes', { user: w.plain.id, tenant: w.world.tenant.id })).status).toBe(403);
  });
});

/** 直接按库查日志编号（租户管理员没有隐含的数据范围，DEC-080，不能用它的查询结果当“全量”）。 */
async function auditIds(db: Db, tenantId: string, objectId: string, action?: string): Promise<string[]> {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT id FROM audit_events WHERE object_id=${objectId}
      AND (${action ?? null}::text IS NULL OR action=${action ?? null}) ORDER BY occurred_at, id`);
    return ((Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[]).map(
      (row) => row.id,
    );
  });
}
