/**
 * PR #75 第五轮（真实授权器）：任职导入的任务日志逐行保存业务对象与归属。
 * - 失败导入：查看人有该员工当前部门的范围，就能按命令编号查到这次失败的导入任务；
 * - 成功导入：A 创建任职业务、B 导入修改它，A 在“使用用户”范围下能看到这次成功的导入任务（创建人按任职业务解析，
 *   不按员工编号）；
 * - P3：恢复对账日志按真实的计数映射结构（changed.<授权表>）展示授权镜像条数，接管任务数与问题清单仍不展示。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, withTenant } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import {
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
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord;

/** 审计管理员 + 任职记录全部字段的查看权；可选组织范围。 */
async function employmentViewer(world: PermissionWorld, label: string, orgRange?: string) {
  const member = await memberWithAdminRole(world, 'audit_admin', label);
  const profile = await createProfile(world, `aud-r5-${randomUUID().slice(0, 8)}`);
  const response = await setObjectPermission(
    world,
    profile,
    {
      dataOperations: { create: false, update: false, delete: false },
      fields: EMPLOYMENT.fields.map((field) => ({ fieldCode: field.code, view: true, edit: false })),
      buttons: [],
    },
    EMPLOYMENT.code,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, member.user.id, profile.id)).status).toBe(201);
  if (orgRange) {
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${member.user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: orgRange, includeDescendants: true }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
  }
  return member;
}

interface Saved {
  readonly id: string;
  readonly revision: number;
  readonly employeeRevision: number;
}

async function fixture() {
  const db = database().db;
  const world = await seedPermissionWorld(db);
  const setup = tenantApi(db, { clock: () => new Date(NOW) });
  async function call(method: string, path: string, body: unknown, revision?: number, user = world.admin.id) {
    const response = await setup.request(method, `/api/tenant/${path}`, {
      user,
      tenant: world.tenant.id,
      ifMatch: revision,
      body,
    });
    expect(response.status, await response.clone().text()).toBeLessThan(300);
    return (await response.json()) as Saved;
  }
  const department = (name: string) =>
    call(
      'POST',
      'org/organizations',
      { name, establishedOn: '2025-01-01', parents: { admin: { parentId: world.tenant.id } } },
      0,
    );
  /** 新员工并直接入职到指定部门；返回入职业务。 */
  async function hired(departmentId: string, user = world.admin.id) {
    const employee = await call(
      'POST',
      'employment/employees',
      { code: `R5_${randomUUID()}`, name: '合成员工' },
      0,
      user,
    );
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
      user,
    );
    return { employeeId: employee.id, hire };
  }
  const importAs = (user: string, employeeId: string, revision: number, commandId: string, body: unknown) =>
    setup.request('POST', `/api/tenant/employment/employees/${employeeId}/import`, {
      user,
      tenant: world.tenant.id,
      ifMatch: revision,
      idempotencyKey: commandId,
      body,
    });
  return { db, world, call, department, hired, importAs, audit: auditApi(db, NOW, { authorize: undefined }) };
}

describe('PR #75 第五轮', () => {
  let w: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    w = await fixture();
  });

  it('失败的任职导入：查看人有该员工当前部门的范围，按命令编号能查到这次失败任务', async () => {
    const inside = await w.department('第五轮范围内部门');
    const { employeeId, hire } = await w.hired(inside.id);
    const scoped = await employmentViewer(w.world, 'aud-r5-failed', inside.id);
    const commandId = randomUUID();
    const response = await w.importAs(w.world.admin.id, employeeId, hire.employeeRevision, commandId, {
      items: [{ operation: 'edit', id: hire.id, revision: 'not-a-number', patch: { fields: { place: '非法' } } }],
    });
    expect(response.status).toBe(400);
    const admin = await auditApi(w.db, NOW).operationLogs(w.world.asAdmin, { behavior: 'import', commandId });
    expect(admin.items).toEqual([expect.objectContaining({ result: 'failed', totalCount: 1 })]);
    const seen = await w.audit.operationLogs(scoped.as, { behavior: 'import', commandId });
    expect(seen.items).toEqual([expect.objectContaining({ result: 'failed', totalCount: 1, failureCount: 1 })]);
    const outside = await w.department('第五轮范围外部门');
    const stranger = await employmentViewer(w.world, 'aud-r5-failed-out', outside.id);
    expect((await w.audit.operationLogs(stranger.as, { behavior: 'import', commandId })).items).toEqual([]);
  });

  it('成功的任职导入：A 创建任职、B 导入修改，A 在“使用用户”范围下能看到这次导入任务', async () => {
    const policy = await w.world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${EMPLOYMENT.code}/entity/${EMPLOYMENT.code}`,
      { ...w.world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    const creator = await employmentViewer(w.world, 'aud-r5-creator');
    const unit = await w.department('第五轮创建人部门');
    const { employeeId, hire } = await w.hired(unit.id, creator.user.id);
    const commandId = randomUUID();
    const response = await w.importAs(w.world.admin.id, employeeId, hire.employeeRevision, commandId, {
      items: [{ operation: 'edit', id: hire.id, revision: hire.revision, patch: { fields: { place: '导入地点' } } }],
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const seen = await w.audit.operationLogs(creator.as, { behavior: 'import', commandId });
    expect(seen.items).toEqual([expect.objectContaining({ result: 'succeeded', totalCount: 1, successCount: 1 })]);
    const other = await employmentViewer(w.world, 'aud-r5-other');
    expect((await w.audit.operationLogs(other.as, { behavior: 'import', commandId })).items).toEqual([]);
  });

  it('P3 恢复对账：按真实计数映射展示授权镜像条数，接管任务数与问题清单不展示', async () => {
    await withTenant(w.db, w.world.tenant.id, (tx) =>
      insertAuditEvent(tx, {
        tenantId: w.world.tenant.id,
        actorUserId: null,
        action: 'tenant.restore.reconcile',
        objectType: 'tenant',
        objectId: w.world.tenant.id,
        before: null,
        after: {
          changed: { permission_admins: 2, tenant_memberships: 1 },
          skipped: 1,
          republished: 2,
          takenOver: 3,
          problems: [{ kind: 'task', id: 'R5-PROBLEM' }],
        },
        occurredAt: new Date(NOW),
      }),
    );
    const only = await memberWithAdminRole(w.world, 'audit_admin', 'aud-r5-restore');
    const { items } = await w.audit.dataChanges(only.as, { action: 'tenant.restore.reconcile' });
    expect(items).toHaveLength(1);
    const fields = items[0]!.changes.map((change) => change.field);
    expect(fields).toEqual(
      expect.arrayContaining(['changed.permission_admins', 'changed.tenant_memberships', 'skipped', 'republished']),
    );
    expect(fields).not.toContain('takenOver');
    expect(JSON.stringify(items)).not.toContain('R5-PROBLEM');
  });
});
