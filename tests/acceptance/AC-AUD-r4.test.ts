/**
 * PR #75 第四轮（真实授权器）：
 * - N1：DEC-203 只放宽“谁能看到配置类日志”，字段权限照常裁剪——合同类型、任职设置等配置对象按各自的权限对象
 *   裁剪差异、渲染文本、详情前后值与字段筛选；业务接口隐藏的字段，审计接口也隐藏；
 * - N2：“使用用户（创建人）”范围下，本人执行的导入任务（成功、冲突、格式校验失败的行）可见，他人的不可见；
 * - N3：平台命令一次失败只写一条平台失败审计（错误被路由转换后不重复记账）；
 * - N4：序码重算汇总里的人员变化数按查看人的人员范围裁剪：没有范围的看不到这次重算，部分范围的只看到范围内的条数。
 */
import { randomUUID } from 'node:crypto';
import { insertAuditEvent, withTenant } from '@italent/db';
import { MODULE_OBJECTS, PERSONNEL_OBJECT } from '@italent/domain';
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
import { PLATFORM, seedOperator } from './support/platform-api.js';

const database = useTestDb();
const NOW = '2026-10-01T01:00:00.000Z';
const ORG = MODULE_OBJECTS.organization;

interface Grant {
  readonly code: string;
  readonly fields: readonly string[];
}

async function viewer(
  world: PermissionWorld,
  label: string,
  grants: readonly Grant[],
  options: { seeAll?: boolean; orgRange?: string } = {},
) {
  const member = await memberWithAdminRole(world, 'audit_admin', label);
  if (!grants.length) return member;
  const profile = await createProfile(world, `aud-r4-${randomUUID().slice(0, 8)}`);
  for (const { code, fields } of grants) {
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
  if (options.seeAll) {
    const all = await world.api.request('PUT', `/api/tenant/permission/profiles/${profile.id}/data-scopes/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { targetKind: 'app', targetCode: '', seeAll: true },
    });
    expect(all.status, await all.clone().text()).toBe(200);
  }
  await makeGrantable(world, [profile.id]);
  expect((await grant(world, member.user.id, profile.id)).status).toBe(201);
  if (options.orgRange) {
    const scope = await world.api.request('PUT', `/api/tenant/permission/scopes/${member.user.id}/TenantBase`, {
      ...world.asAdmin,
      ifMatch: 0,
      body: { kind: 'org_range', orgRanges: [{ orgId: options.orgRange, includeDescendants: true }] },
    });
    expect(scope.status, await scope.clone().text()).toBe(200);
  }
  return member;
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
    return (await response.json()) as { id: string; revision: number };
  }
  const org = (name: string) =>
    call(
      'POST',
      'org/organizations',
      { name, establishedOn: '2025-01-01', parents: { admin: { parentId: world.tenant.id } } },
      0,
    );
  return { db, world, setup, call, org, audit: auditApi(db, NOW, { authorize: undefined }) };
}

describe('PR #75 第四轮', () => {
  let w: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    w = await fixture();
  });

  it('N1 合同类型日志：业务接口只给看编码的查看人，审计里也只看到编码；字段筛选不能探测隐藏字段', async () => {
    const type = await w.call('POST', 'contracts/master-data/types', { code: 'R4-LABOR', name: '第四轮隐藏名称' }, 0);
    const codeOnly = await viewer(w.world, 'aud-r4-type', [{ code: 'TenantBase.ContractType', fields: ['code'] }], {
      seeAll: true,
    });
    const business = tenantApi(w.db, { authorize: undefined, clock: () => new Date(NOW) });
    const listed = await business.request('GET', '/api/tenant/contracts/master-data/types', codeOnly.as);
    expect(listed.status, await listed.clone().text()).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain('第四轮隐藏名称');

    const { items } = await w.audit.dataChanges(codeOnly.as, { objectId: type.id });
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('第四轮隐藏名称');
    expect(items[0]!.content).toContain('R4-LABOR');
    const detail = await w.audit.dataChange(codeOnly.as, items[0]!.id);
    expect(JSON.stringify(detail)).not.toContain('第四轮隐藏名称');
    expect((await w.audit.dataChanges(codeOnly.as, { objectId: type.id, field: 'name' })).items).toEqual([]);

    // 只持审计身份（没有合同类型字段权限）：DEC-203 仍能看到这条配置日志，但看不到任何字段值
    const only = await viewer(w.world, 'aud-r4-type-only', []);
    const bare = await w.audit.dataChanges(only.as, { objectId: type.id });
    expect(bare.items).toHaveLength(1);
    expect(JSON.stringify(bare.items)).not.toContain('第四轮隐藏名称');
    expect(JSON.stringify(bare.items)).not.toContain('R4-LABOR');
  });

  it('N1 任职设置日志按任职设置的字段权限裁剪', async () => {
    await w.call('PUT', 'employment/settings', { allowDirectTransfer: false }, 0);
    const admin = await auditApi(w.db, NOW).dataChanges(w.world.asAdmin, { objectType: 'employment_settings' });
    expect(JSON.stringify(admin.items)).toContain('allowDirectTransfer');
    const blind = await viewer(w.world, 'aud-r4-settings', [
      { code: 'TenantBase.EmploymentSettings', fields: ['revision'] },
    ]);
    const { items } = await w.audit.dataChanges(blind.as, { objectType: 'employment_settings' });
    expect(items.length).toBeGreaterThan(0);
    expect(JSON.stringify(items)).not.toContain('allowDirectTransfer');
    expect(
      (await w.audit.dataChanges(blind.as, { objectType: 'employment_settings', field: 'allowDirectTransfer' })).items,
    ).toEqual([]);
  });

  it('N2 “使用用户”范围：本人的导入任务（成功、冲突、格式失败的行）可见，他人的不可见', async () => {
    const creator = await viewer(w.world, 'aud-r4-creator', [
      { code: ORG.code, fields: ORG.fields.map((field) => field.code) },
    ]);
    const policy = await w.world.api.request(
      'PUT',
      `/api/tenant/permission/scope-policies/TenantBase/${ORG.code}/entity/${ORG.code}`,
      { ...w.world.asAdmin, ifMatch: 0, body: { rules: [{ dimension: 'using_user' }] } },
    );
    expect(policy.status, await policy.clone().text()).toBe(200);
    const importAs = (user: string, commandId: string, rows: unknown[]) =>
      w.setup.request('POST', '/api/tenant/org/import', {
        user,
        tenant: w.world.tenant.id,
        ifMatch: 0,
        idempotencyKey: commandId,
        body: { rows },
      });
    const own = randomUUID();
    const mine = await importAs(creator.user.id, own, [
      { sourceCode: 'R4-S1', code: 'R4-OWN', name: '本人导入部门', parentId: w.world.tenant.id },
      { sourceCode: 'R4-S2', code: 'R4-OWN', name: '本人冲突部门', parentId: w.world.tenant.id },
    ]);
    expect(mine.status, await mine.clone().text()).toBe(200);
    const failed = randomUUID();
    const bad = await importAs(creator.user.id, failed, [
      { sourceCode: 'R4-S3', code: 'R4-BAD', name: '格式错误', parentId: 'not-a-uuid' },
    ]);
    expect(bad.status).toBe(400);
    const others = randomUUID();
    const theirs = await importAs(w.world.admin.id, others, [
      { sourceCode: 'R4-S4', code: 'R4-ADMIN', name: '他人导入部门', parentId: w.world.tenant.id },
    ]);
    expect(theirs.status, await theirs.clone().text()).toBe(200);

    const logs = async (commandId: string) =>
      (await w.audit.operationLogs(creator.as, { behavior: 'import', commandId })).items;
    expect(await logs(own)).toEqual([expect.objectContaining({ totalCount: 2, successCount: 1, failureCount: 1 })]);
    expect(await logs(failed)).toEqual([expect.objectContaining({ result: 'failed', totalCount: 1 })]);
    expect(await logs(others)).toEqual([]);
  });

  it('N3 平台重复邮箱建用户：一次请求恰好一条平台失败审计', async () => {
    const api = tenantApi(w.db, { authorize: undefined, clock: () => new Date(NOW) });
    const operator = await seedOperator(w.db, 'aud-r4-ops');
    const email = `aud-r4-${randomUUID().slice(0, 8)}@example.com`;
    const create = (commandId: string) =>
      api.request('POST', `${PLATFORM}/users`, {
        user: operator.id,
        idempotencyKey: commandId,
        body: { email, displayName: '第四轮合成用户' },
      });
    expect((await create(randomUUID())).status).toBe(201);
    const commandId = randomUUID();
    expect((await create(commandId)).status).toBe(409);
    const read = await api.request('GET', `${PLATFORM}/command-failures?commandId=${commandId}`, { user: operator.id });
    expect(read.status).toBe(200);
    expect(((await read.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('N4 序码重算汇总：没有人员范围的看不到这次重算，部分范围的只看到范围内的变化人数', async () => {
    const inside = await w.org('第四轮序码范围内部门');
    const outside = await w.org('第四轮序码范围外部门');
    for (const departmentId of [inside.id, outside.id]) {
      const employee = await w.call(
        'POST',
        'employment/employees',
        { code: `R4_${randomUUID()}`, name: '序码员工' },
        0,
      );
      await w.call(
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
    }
    await w.call(
      'PUT',
      'personnel/order-code/settings',
      { enabled: true, items: [{ field: 'code', direction: 'asc', enabled: true }] },
      0,
    );
    await w.call('POST', 'personnel/order-code/recompute', {}, 1);
    const full = await auditApi(w.db, NOW).dataChanges(w.world.asAdmin, { objectType: 'personnel-order-run' });
    expect(full.items).toHaveLength(1);
    const total = full.items[0]!.changes.find((change) => change.field === 'changed')?.to as number;
    expect(total).toBeGreaterThanOrEqual(2);

    const none = await viewer(w.world, 'aud-r4-order-none', []);
    expect((await w.audit.dataChanges(none.as, { objectType: 'personnel-order-run' })).items).toEqual([]);

    const partial = await viewer(w.world, 'aud-r4-order-partial', [{ code: PERSONNEL_OBJECT, fields: ['orderCode'] }], {
      orgRange: inside.id,
    });
    const seen = await w.audit.dataChanges(partial.as, { objectType: 'personnel-order-run' });
    expect(seen.items).toHaveLength(1);
    const visible = seen.items[0]!.changes.find((change) => change.field === 'changed')?.to;
    expect(visible).toBe(1);
    expect(seen.items[0]!.content).not.toContain(`修改为【${total}】`);
  });

  it('汇总计数同类：恢复对账日志里的接管任务数与问题清单（审批等业务派生）不在审计中展示，授权镜像条数照常', async () => {
    await withTenant(w.db, w.world.tenant.id, (tx) =>
      insertAuditEvent(tx, {
        tenantId: w.world.tenant.id,
        actorUserId: null,
        action: 'tenant.restore.reconcile',
        objectType: 'tenant',
        objectId: w.world.tenant.id,
        before: null,
        after: { changed: 4, skipped: 1, republished: 2, takenOver: 3, problems: [{ kind: 'task', id: 'R4-PROBLEM' }] },
        occurredAt: new Date(NOW),
      }),
    );
    const only = await viewer(w.world, 'aud-r4-restore', []);
    const { items } = await w.audit.dataChanges(only.as, { action: 'tenant.restore.reconcile' });
    expect(items).toHaveLength(1);
    const fields = items[0]!.changes.map((change) => change.field);
    expect(fields).toEqual(expect.arrayContaining(['changed', 'skipped', 'republished']));
    expect(fields).not.toContain('takenOver');
    expect(JSON.stringify(items)).not.toContain('R4-PROBLEM');
  });
});
