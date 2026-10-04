/** AC-FWD-14 / DEC-120：整条跳过提醒同样受数据范围与字段权限约束（真实授权器）。 */
import { randomUUID } from 'node:crypto';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import {
  addMember,
  createProfile,
  grant,
  makeGrantable,
  seedPermissionWorld,
  setObjectPermission,
} from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();

describe('AC-FWD-14 DEC-120 整条跳过提醒的范围与字段裁剪', () => {
  it('范围外的整条跳过记录不出现；隐藏字段从提醒中裁剪，可见字段照常列出', async () => {
    const db = database().db;
    const seed = await seedPermissionWorld(db);
    const clock = () => new Date('2026-10-01T01:00:00.000Z');
    const api = tenantApi(db, { authorize: undefined, clock });
    const setup = tenantApi(db, { clock });
    async function create(path: string, body: unknown, revision = 0) {
      const response = await setup.request('POST', `/api/tenant/${path}`, { ...seed.asAdmin, ifMatch: revision, body });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string; revision: number; employeeRevision: number };
    }
    const org = async (name: string) =>
      create('org/organizations', { name, startDate: '2025-01-01', parents: { admin: { parentId: seed.tenant.id } } });
    const job = (kind: string, extra: Record<string, unknown> = {}) =>
      create(`job/${kind}`, {
        name: `合成${kind}-${randomUUID()}`,
        code: `F14_${randomUUID()}`,
        startDate: '2025-01-01',
        ...extra,
      });
    const inside = await org('范围内部门');
    const inside2 = await org('范围内调入部门');
    const outside = await org('范围外部门');
    const post = await job('posts');
    const positionB = await job('positions', { orgId: inside.id, postId: post.id });
    const positionC = await job('positions', { orgId: inside2.id, postId: post.id });
    const positionOut = await job('positions', { orgId: outside.id, postId: post.id });
    const managers: string[] = [];
    for (const name of ['原经理', '新经理']) {
      const manager = await create('employment/employees', { code: `M_${randomUUID()}`, name });
      await create(
        `employment/employees/${manager.id}/businesses`,
        { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { employType: 'internal' } },
        manager.revision,
      );
      managers.push(manager.id);
    }
    const employee = await create('employment/employees', { code: `E_${randomUUID()}`, name: '提醒合成员工' });
    const hire = await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2026-01-01',
        fields: { departmentId: inside.id, place: '原地点', directManagerId: managers[0] },
      },
      employee.revision,
    );
    const outsideRecord = await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-15',
        fields: { departmentId: outside.id, positionId: positionOut.id },
      },
      hire.employeeRevision,
    );
    const insideRecord = await create(
      `employment/employees/${employee.id}/businesses`,
      {
        kind: 'transfer',
        mode: 'direct',
        effectiveDate: '2026-09-20',
        fields: { departmentId: inside.id, positionId: positionB.id },
      },
      outsideRecord.employeeRevision,
    );
    const reader = await addMember(seed, 'skip-reader');
    const profile = await createProfile(seed, 'skip-reader-profile');
    for (const definition of [
      { code: 'TenantBase.Employee', fields: ['id', 'code', 'revision', 'status'], buttons: [] },
      {
        code: MODULE_OBJECTS.employmentRecord.code,
        fields: ['id', 'employeeId', 'revision', 'effectiveDate', 'kind', 'status', 'departmentId', 'place', 'staffId'],
        buttons: MODULE_OBJECTS.employmentRecord.buttons.map((button) => ({
          buttonCode: button.code,
          level: button.level,
        })),
      },
    ]) {
      const response = await setObjectPermission(
        seed,
        profile,
        {
          dataOperations: { create: false, update: false, delete: false },
          fields: definition.fields.map((fieldCode) => ({ fieldCode, view: true, edit: false })),
          buttons: definition.buttons,
        },
        definition.code,
      );
      expect(response.status).toBe(200);
    }
    await makeGrantable(seed, [profile.id]);
    expect((await grant(seed, reader.id, profile.id)).status).toBe(201);
    const scope = await api.request('PUT', `/api/tenant/permission/scopes/${reader.id}/TenantBase`, {
      ...seed.asAdmin,
      ifMatch: 0,
      body: {
        kind: 'org_range',
        orgRanges: [
          { orgId: inside.id, includeDescendants: false },
          { orgId: inside2.id, includeDescendants: false },
        ],
      },
    });
    expect(scope.status).toBe(200);
    const preview = await api.request(
      'POST',
      `/api/tenant/employment/employees/${employee.id}/forward-update-preview`,
      {
        user: reader.id,
        tenant: seed.tenant.id,
        body: {
          kind: 'transfer',
          mode: 'direct',
          effectiveDate: '2026-09-11',
          fields: { departmentId: inside2.id, positionId: positionC.id, directManagerId: managers[1], place: '新地点' },
        },
      },
    );
    const text = await preview.text();
    expect(preview.status, text).toBe(200);
    const body = JSON.parse(text) as { changes: unknown[]; wholeRecordSkips: Record<string, unknown>[] };
    expect(body.changes).toEqual([]);
    expect(body.wholeRecordSkips).toEqual([
      {
        businessId: insideRecord.id,
        staffId: expect.any(String),
        status: 'effective',
        effectiveDate: '2026-09-20',
        reason: 'DEPARTMENT_POSITION_MISMATCH',
        fields: [{ field: 'place', before: '原地点', after: '新地点' }],
      },
    ]);
    expect(text).not.toContain(outsideRecord.id);
    expect(text).not.toContain(managers[0]!);
    expect(text).not.toContain(managers[1]!);
  });
});
