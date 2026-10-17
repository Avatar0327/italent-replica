/**
 * R2 BE-8a 黑名单验收夹具（B68；docs/02_业务建模/30 DM-R2；DEC-569）：经公开接口维护黑名单、读取业务表计数。
 * 只用旧 main 已有的夹具；黑名单能力缺失时测试得到 404 / 断言失败，而不是导入错误。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { employmentSession, type EmploymentSession } from './AC-EMP-support.js';
import type { RequestOptions } from './support/tenant-api.js';

export interface BlacklistEntry {
  readonly id: string;
  readonly employeeId: string | null;
  readonly name: string;
  readonly idNumber: string | null;
  readonly mobilePhone: string | null;
  readonly email: string | null;
  readonly reason: string;
  readonly blacklistDate: string;
  readonly expiryDate: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly status: 'active' | 'removed';
  readonly revision: number;
}

export interface BlacklistPage {
  readonly items: BlacklistEntry[];
  readonly hasDataPermission: boolean;
}

export const rowsOf = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export function blacklistApi(session: EmploymentSession) {
  const add = (body: unknown, options: RequestOptions = {}) =>
    session.request('POST', '/blacklist', { ifMatch: 0, body, ...options });
  async function added(body: Record<string, unknown>): Promise<BlacklistEntry> {
    const response = await add(body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as BlacklistEntry;
  }
  async function list(query = ''): Promise<BlacklistPage> {
    const response = await session.request('GET', `/blacklist${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as BlacklistPage;
  }
  const edit = (id: string, revision: number, body: unknown) =>
    session.request('PUT', `/blacklist/${id}`, { ifMatch: revision, body });
  const remove = (items: { id: string; revision: number }[]) =>
    session.request('POST', '/blacklist/remove', { body: { items } });
  const destroy = (items: { id: string; revision: number }[]) =>
    session.request('POST', '/blacklist/delete', { body: { items } });
  return { add, added, list, edit, remove, destroy };
}

/** 已离职员工：入职 2025-01-01、最后工作日 2026-03-31（离职生效 04-01）；人员档案带证件号 / 手机 / 邮箱。 */
export async function leftEmployee(
  db: Db,
  session: EmploymentSession,
  name: string,
  person: { idNumber?: string; mobilePhone?: string; email?: string } = {},
  ending: 'leave' | 'retirement' = 'leave',
) {
  const org = await session.org(`黑名单部门-${name}`, { establishedOn: '2025-01-01' });
  const employee = await session.employee(name);
  const hire = { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } };
  const hired = await session.business(employee.id, hire, employee.revision);
  const left = await session.business(
    employee.id,
    { kind: ending, mode: 'direct', lastWorkDate: '2026-03-31', fields: {} },
    hired.employeeRevision,
  );
  if (Object.keys(person).length) await setPersonIdentity(db, session, employee.id, person);
  return { employee: { ...employee, revision: left.employeeRevision }, org };
}

/** 直接在人员档案最新版本上写证件号 / 手机 / 邮箱（合成数据；档案写接口不在本单范围）。 */
export async function setPersonIdentity(
  db: Db,
  session: EmploymentSession,
  employeeId: string,
  person: { idNumber?: string; mobilePhone?: string; email?: string },
) {
  const tenantId = session.tenant.id;
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`
      INSERT INTO personnel_employee_versions(tenant_id, employee_id, revision, command_id, created_by, name,
        id_number, mobile_phone, email)
      SELECT ${tenantId}, ${employeeId}::uuid, COALESCE(max(v.revision), 0) + 1, 'blacklist-fixture',
        ${session.user.id}::uuid, e.name, ${person.idNumber ?? null}, ${person.mobilePhone ?? null},
        ${person.email ?? null}
      FROM employment_employees e
      LEFT JOIN personnel_employee_versions v ON v.tenant_id = e.tenant_id AND v.employee_id = e.id
      WHERE e.tenant_id = ${tenantId} AND e.id = ${employeeId}::uuid
      GROUP BY e.name`),
  );
}

/** 任职、人员与待入职相关业务表的行数（拦截时“无任何写入”的前后比对）。 */
export async function businessCounts(db: Db, tenantId: string) {
  const tables = [
    'employment_employees',
    'employment_business_objects',
    'employment_payload_versions',
    'employment_state_events',
    'employment_records',
    'employment_timeline',
    'employment_cycles',
    'employment_outbox',
    'employment_pending_entry_probation',
    'employment_pending_entry_contract',
    'employment_entry_actions',
    'personnel_employee_versions',
    'employment_blacklist',
    'command_ledger',
  ];
  return withTenant(db, tenantId, async (tx) => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const [row] = rowsOf<{ n: number }>(
        await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}`),
      );
      counts[table] = row!.n;
    }
    return counts;
  });
}

export async function blacklistWorld(db: Db, label: string) {
  const session = await employmentSession(db, `blacklist-${label}`);
  return { db, session, ...blacklistApi(session) };
}
export type BlacklistWorld = Awaited<ReturnType<typeof blacklistWorld>>;
