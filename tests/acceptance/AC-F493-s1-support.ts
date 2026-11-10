/**
 * F-493 S1 验收夹具：工号为空的员工只能经 createEmployee 建（任职主档身份字段不可变，触发器禁止 UPDATE）。
 * 全部读写放进租户的 withTenant，普通角色（app_owner，F-212）下同样通过。
 */
import { randomUUID } from 'node:crypto';
import { withTenant, type Db } from '@italent/db';
import { createEmployee } from '../../apps/api/src/modules/employment/employees.js';
import type { EmploymentSession } from './AC-EMP-support.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';

interface Session {
  readonly tenant: { readonly id: string; readonly timezone: string };
  readonly user: { readonly id: string };
}

/** 建一名工号为空的员工（revision = 1，与 API 建档同形）。 */
export async function nullCodeEmployee(db: Db, session: Session, name: string) {
  const context = {
    tenantId: session.tenant.id,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date('2026-10-01T01:00:00.000Z'),
    commandId: randomUUID(),
    expectedRevision: 0,
  } satisfies EmploymentContext;
  return withTenant(db, session.tenant.id, (tx) => createEmployee(tx, context, { code: null, name }));
}

/** 工号为空的员工办理直接入职（合成登录名由 session.business 补上）。 */
export async function hireNullCode(
  db: Db,
  session: EmploymentSession,
  name: string,
  fields: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const employee = await nullCodeEmployee(db, session, name);
  const hire = await session.business(
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields, ...extra },
    employee.revision,
  );
  return { employee, hire };
}
