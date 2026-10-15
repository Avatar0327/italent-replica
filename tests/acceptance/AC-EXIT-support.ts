/**
 * R2-T03 离职验收测试的共用夹具（设计 §4A：业务造数放这里，packages/testkit 不放业务造数）。
 * 只用旧 main 已有的夹具与导出（任职会话、种子登记表、SQL），离职能力缺失时测试得到 404 / 断言失败，而不是导入错误。
 * seedExitBusiness：可信造数——经现有任职入口办入职与直接离职，再用 SQL 补写离职扩展行；
 * B2a 接入离职门禁后改走服务端可信端口 ctx.trustedExit = 'seed'（§4A），调用方签名不变。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { employmentSession } from './AC-EMP-support.js';
import type { RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export interface ExitDictionaryEntry {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly revision: number;
}

export const installExitSeeds = (db: Db, tenantId: string) =>
  withTenant(db, tenantId, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId, actorUserId: null, now: new Date(), commandId: `exit-seed-${randomUUID()}` },
      { modules: ['employment'] },
    ),
  );

export async function exitWorld(db: Db, label: string) {
  const session = await employmentSession(db, `exit-${label}`);
  await installExitSeeds(db, session.tenant.id);
  const path = (kind: string, id?: string) => `/exits/dictionaries/${kind}${id ? `/${id}` : ''}`;
  async function list(kind: string, query = '') {
    const response = await session.request('GET', `${path(kind)}${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: ExitDictionaryEntry[] }).items;
  }
  const add = (kind: string, body: unknown, options: RequestOptions = {}) =>
    session.request('POST', path(kind), { ifMatch: 0, body, ...options });
  const update = (kind: string, id: string, revision: number, body: unknown) =>
    session.request('PUT', path(kind, id), { ifMatch: revision, body });
  async function added(kind: string, body: Record<string, unknown>) {
    const response = await add(kind, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ExitDictionaryEntry;
  }
  /** 在本租户事务（app_user + RLS）里执行一条语句：成功返回 undefined，失败返回错误文本（只回滚这个事务）。 */
  async function attempt(statement: ReturnType<typeof sql>, tenantId = session.tenant.id) {
    try {
      await withTenant(db, tenantId, (tx) => tx.execute(statement));
      return undefined;
    } catch (error) {
      return String((error as { cause?: unknown }).cause ?? error);
    }
  }
  /** 可信造数：直接离职一条（main 现有任职入口）并补写离职扩展行；extra 覆盖扩展行列（列名 → 值）。 */
  async function seedExitBusiness(extra: Record<string, string> = {}) {
    const org = await session.org(`离职部门${uniqueSuffix()}`, { establishedOn: '2025-01-01' });
    const created = await session.employee('离职员工');
    const hire = { kind: 'hire', mode: 'direct', effectiveDate: '2025-01-01', fields: { departmentId: org.id } };
    await session.business(created.id, hire, created.revision);
    const employee = await session.getEmployee(created.id);
    const leave = { kind: 'leave', mode: 'direct', lastWorkDate: '2026-09-20' };
    const business = await session.business(employee.id, leave, employee.revision);
    const columns = { mode: 'direct', initiator: 'hr', duty_transfer_timing: 'business_effective', ...extra };
    const error = await attempt(sql`
      INSERT INTO exit_requests(tenant_id, business_id, employee_id, staff_id, initiator_user_id,
        ${sql.join(
          Object.keys(columns).map((c) => sql.identifier(c)),
          sql`, `,
        )})
      SELECT ${session.tenant.id}, ${business.id}, ${employee.id}, c.id, ${session.user.id},
        ${sql.join(
          Object.values(columns).map((v) => sql`${v}`),
          sql`, `,
        )}
      FROM employment_cycles c WHERE c.tenant_id = ${session.tenant.id} AND c.employee_id = ${employee.id}
      ORDER BY c.entry_date DESC LIMIT 1`);
    return { employee, business, error };
  }
  return { ...session, db, list, add, update, added, attempt, seedExitBusiness };
}

export type ExitWorld = Awaited<ReturnType<typeof exitWorld>>;
