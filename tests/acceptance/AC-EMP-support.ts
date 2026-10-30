import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';

export const EMP_TODAY = '2026-10-01';

export interface Employee {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'pending' | 'employed' | 'left' | 'retired';
  readonly revision: number;
}

export interface EmploymentRecord {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly entryDate: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly stopDate: string;
  readonly previousRecordId: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly customFields: Readonly<Record<string, unknown>>;
  readonly isCurrent: boolean;
  readonly isLatest: boolean;
  readonly status: 'effective';
  readonly isInserted: boolean;
  readonly before?: unknown;
}

export interface EmploymentBusiness {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly employeeRevision: number;
  readonly status: 'draft' | 'in_review' | 'approved' | 'rejected' | 'effective' | 'deleted';
  readonly kind: string;
  readonly effectiveDate: string;
  readonly record: EmploymentRecord | null;
}

const NEW_CYCLE_KINDS = new Set(['hire', 'rehire', 'retire_rehire']);

/** 人员的合成登录邮箱（按人员编号确定，重聘时与首次入职一致，不会触发改绑拒绝）。 */
export function loginEmailOf(employeeId: string): string {
  return `person-${employeeId}@example.com`;
}

/** DEC-140：办理入职必须有登录邮箱；入职类业务未指定时补上该人员的合成登录邮箱。 */
export function withLoginEmail(employeeId: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!NEW_CYCLE_KINDS.has(String(body.kind)) || 'loginEmail' in body) return body;
  return { ...body, loginEmail: loginEmailOf(employeeId) };
}

/**
 * BE-3：转正须选试用结果字典项，夹具租户补装预置项（DEC-361 种子，新租户开通即装）。
 * 升级类用例（migrateBefore）停在旧表结构上，字典表还不存在时跳过，夹具照旧可用。
 */
export async function installProbationSeeds(db: Db, tenantId: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(sql`SELECT to_regclass('employment_probation_results') IS NOT NULL AS ready`);
    const [row] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { ready: boolean }[];
    if (!row?.ready) return;
    await installMissingSeeds(
      tx,
      { tenantId, actorUserId: null, now: new Date(), commandId: `probation-seed-${randomUUID()}` },
      { modules: ['employment-probation'] },
    );
    const forms = await tx.execute(sql`SELECT to_regclass('employment_forms') IS NOT NULL AS ready`);
    const [formsReady] = (Array.isArray(forms) ? forms : (forms as { rows: unknown[] }).rows) as { ready: boolean }[];
    if (formsReady?.ready)
      await installMissingSeeds(
        tx,
        { tenantId, actorUserId: null, now: new Date(), commandId: `forms-seed-${randomUUID()}` },
        { modules: ['employment-forms'] },
      );
    // F-323：人员类别预置 8 条（新租户开通即装）
    const types = await tx.execute(sql`SELECT to_regclass('employment_types') IS NOT NULL AS ready`);
    const [typesReady] = (Array.isArray(types) ? types : (types as { rows: unknown[] }).rows) as { ready: boolean }[];
    if (typesReady?.ready)
      await installMissingSeeds(
        tx,
        { tenantId, actorUserId: null, now: new Date(), commandId: `types-seed-${randomUUID()}` },
        { modules: ['employment-types'] },
      );
  });
}

/** F-323：按名称取本租户人员类别 ID（预置项名称见 17 §F-323）。 */
export async function employmentTypeId(db: Db, tenantId: string, name: string): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id FROM employment_types WHERE tenant_id=${tenantId} AND name=${name} AND deleted_at IS NULL`,
    );
    const [row] = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { id: string }[];
    if (!row) throw new Error(`人员类别不存在：${name}`);
    return row.id;
  });
}

export async function employmentSession(db: Db, label: string, options: { timezone?: string } = {}) {
  const member = await seedTenantWithMember(db, label, options.timezone);
  await installProbationSeeds(db, member.tenant.id);
  let now = new Date(`${EMP_TODAY}T01:00:00.000Z`);
  const api = tenantApi(db, { clock: () => now });
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/employment${path}`, {
      ...options,
      user: member.user.id,
      tenant: member.tenant.id,
    });

  async function employee(name = '合成员工', code = `EMP_${randomUUID().replaceAll('-', '')}`): Promise<Employee> {
    const response = await request('POST', '/employees', { ifMatch: 0, body: { name, code } });
    expect(response.status).toBe(201);
    const created = (await response.json()) as Employee;
    expect(created.id).not.toBe(member.user.id);
    return created;
  }

  async function getEmployee(id: string): Promise<Employee> {
    const response = await request('GET', `/employees/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as Employee;
  }

  async function business(
    employeeId: string,
    body: Record<string, unknown>,
    revision: number,
  ): Promise<EmploymentBusiness> {
    // 转正必填试用结果（BE-3）：没指定时取预置的“正常转正”
    const withResult =
      body.kind === 'regularization' && !('probationResult' in body) ? { ...body, probationResult: 'normal' } : body;
    const response = await request('POST', `/employees/${employeeId}/businesses`, {
      ifMatch: revision,
      body: withLoginEmail(employeeId, withResult),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as EmploymentBusiness;
  }

  async function records(employeeId: string, asOf = EMP_TODAY): Promise<EmploymentRecord[]> {
    const response = await request('GET', `/employees/${employeeId}/records?asOf=${asOf}`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: EmploymentRecord[] }).items;
  }

  async function record(recordId: string, asOf = EMP_TODAY): Promise<EmploymentRecord> {
    const response = await request('GET', `/records/${recordId}?asOf=${asOf}`);
    expect(response.status).toBe(200);
    return (await response.json()) as EmploymentRecord;
  }

  async function org(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<{ id: string; name: string; revision: number }> {
    const response = await api.request('POST', '/api/tenant/org/organizations', {
      user: member.user.id,
      tenant: member.tenant.id,
      ifMatch: 0,
      body: { name, parents: { admin: { parentId: member.tenant.id } }, ...extra },
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; name: string; revision: number };
  }

  return {
    ...member,
    request,
    employee,
    getEmployee,
    business,
    records,
    record,
    org,
    setNow(iso: string) {
      now = new Date(iso);
    },
  };
}

export type EmploymentSession = Awaited<ReturnType<typeof employmentSession>>;
