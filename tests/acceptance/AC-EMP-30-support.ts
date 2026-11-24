/**
 * AC-EMP-30 / AC-EMP-32 共用夹具（F-036-S5）：真实授权器下的“纯经理”世界、HR 草稿、直接调动、组织改名联动。
 * 世界说明见 AC-EMP-30 文件头：纯经理有任职对象查看权与经理入口，负责 A、B 两个部门，
 * 数据范围含 A、B、范围内非团队部门，不含“范围外部门”。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import { approvalWorld, permissionAdmin, type ApprovalWorld } from './AC-APV-support.js';
import { createProfile, setObjectPermission } from './AC-PRM-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const BASE = '/api/tenant/employment';
export const UNIFIED_404 = { error: { code: 'NOT_FOUND', message: '任职业务不存在' } };

export async function hrDraft(w: ApprovalWorld, employeeId: string, fields: object, effectiveDate = '2026-11-01') {
  const current = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${employeeId}`),
  );
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `${BASE}/transfers/employees/${employeeId}`, {
      ifMatch: current.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'in_department',
        formId: 'TenantBase.TransferMultiFormView',
        effectiveDate,
        mode: 'application',
        fields,
      },
    }),
    201,
  );
}

export interface OriginField {
  fieldCode: string;
  value: unknown;
  origin: { kind: string; sourceBusinessId: string | null } | null;
}

/** hidden：纯经理没有这些字段的查看权（字段编码取权限对象的字段码）。 */
export async function managerWorld(db: Db, hidden: string[] = []) {
  const w = await approvalWorld(db, `emp30-${uniqueSuffix()}`);
  w.setNow('2026-10-01T01:00:00Z');
  const api = tenantApi(w.db, { authorize: undefined, clock: w.clock });
  const a = await w.org('负责组织 A');
  const b = await w.org('负责组织 B');
  const outside = await w.org('范围内非团队组织');
  const far = await w.org('范围外组织');
  const manager = await w.person('纯经理', a);
  const member = await w.person('团队成员', a);
  const member2 = await w.person('团队成员二', a);
  const stranger = await w.person('范围内非团队成员', outside);
  const away = await w.person('范围外员工', far);
  const bystander = await w.person('无任何权限者', a);
  await w.setOrgRoles(a, { head: manager.employeeId });
  await w.setOrgRoles(b, { head: manager.employeeId });
  const admin = await permissionAdmin(w);
  const profile = await createProfile(admin, 'department_manager_self_service');
  const definition = MODULE_OBJECTS.employmentRecord;
  const configured = await setObjectPermission(
    admin,
    profile,
    {
      dataOperations: { create: true, update: true, delete: false },
      fields: definition.fields.map((f) => ({ fieldCode: f.code, view: !hidden.includes(f.code), edit: !f.system })),
      buttons: [{ buttonCode: 'Transfer.Manager', level: 'detail' as const }],
    },
    definition.code,
  );
  expect(configured.status, await configured.clone().text()).toBe(200);
  const scope = await admin.api.request('PUT', `/api/tenant/permission/scopes/${manager.userId}/TenantBase`, {
    ...admin.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [a, b, outside].map((orgId) => ({ orgId, includeDescendants: true })) },
  });
  expect(scope.status, await scope.clone().text()).toBe(200);
  const actor = w.as(manager.userId);
  const read = (path: string, who: { user?: string; tenant?: string } = actor) => api.request('GET', path, who);
  return { w, a, b, outside, far, member, member2, stranger, away, bystander, manager, actor, read };
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown };
}
export async function bodyOf(response: Response) {
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as ErrorEnvelope };
}

export async function directTransfer(w: ApprovalWorld, employeeId: string, departmentId: string, place: string) {
  const current = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${employeeId}`),
  );
  return w.json<{ id: string }>(
    await w.request(w.hr.id, 'POST', `${BASE}/transfers/employees/${employeeId}`, {
      ifMatch: current.revision,
      body: {
        initiator: 'hr',
        transferTypeCode: 'in_department',
        formId: 'TenantBase.TransferMultiFormView',
        effectiveDate: '2026-10-01',
        mode: 'direct',
        fields: { departmentId, place },
      },
    }),
    201,
  );
}

/** setOrgRoles 直接追加了组织版本而没推进对象 revision；改名前先对齐，否则版本号冲突。 */
export async function rename(w: ApprovalWorld, orgId: string) {
  await withTenant(w.db, w.tenant.id, (tx) =>
    tx.execute(sql`UPDATE org_objects SET revision = (SELECT max(version_no) FROM org_versions
      WHERE tenant_id = ${w.tenant.id} AND org_id = ${orgId}::uuid)
      WHERE tenant_id = ${w.tenant.id} AND id = ${orgId}::uuid`),
  );
  const org = await w.json<{ revision: number }>(
    await w.request(w.hr.id, 'GET', `/api/tenant/org/organizations/${orgId}`),
  );
  const response = await w.request(w.hr.id, 'PATCH', `/api/tenant/org/organizations/${orgId}`, {
    ifMatch: org.revision,
    body: { name: `改名${uniqueSuffix()}`, effectiveDate: '2026-10-08', addEmployment: true },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

export async function adjustmentOf(w: ApprovalWorld, employeeId: string) {
  const records = await w.json<{ items: { id: string; kind: string }[] }>(
    await w.request(w.hr.id, 'GET', `${BASE}/employees/${employeeId}/records?asOf=2026-10-10`),
  );
  return records.items.find((record) => record.kind === 'org_adjustment')!;
}
