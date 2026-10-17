/**
 * BE-14a Offer 验收夹具：租户 + 管理员，录用部门、员工（直线上级 / HRBP）、职级、合同主体用现有接口或可信 SQL 造数。
 * authorize 可替换，用于按钮 / 范围拒绝用例；造数始终走“全部允许”的另一个应用实例。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installMissingSeeds } from '../../apps/api/src/seeds/index.js';
import { seedTenantWithMember, tenantApi, type RequestOptions } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const OF_NOW = new Date('2026-10-17T01:00:00.000Z');

export interface OfferBody {
  readonly id: string;
  readonly status: string;
  readonly approvalStatus: string;
  readonly offerType: string | null;
  readonly revision: number;
  readonly [key: string]: unknown;
}

const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];

export async function offerWorld(db: Db, label: string, authorize?: Authorizer) {
  const member = await seedTenantWithMember(db, `of-${label}`);
  const as = { user: member.user.id, tenant: member.tenant.id };
  const seeder = tenantApi(db, { clock: () => OF_NOW });
  const api = authorize ? tenantApi(db, { clock: () => OF_NOW, authorize }) : seeder;
  await withTenant(db, member.tenant.id, (tx) =>
    installMissingSeeds(
      tx,
      { tenantId: member.tenant.id, actorUserId: null, now: OF_NOW, commandId: `of-seed-${randomUUID()}` },
      { modules: ['offer'] },
    ),
  );
  const created = async (path: string, body: unknown) => {
    const response = await seeder.request('POST', path, { ...as, ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const department = await created('/api/tenant/org/organizations', {
    name: `录用部门${uniqueSuffix()}`,
    parents: { admin: { parentId: member.tenant.id } },
  });
  const employee = () =>
    created('/api/tenant/employment/employees', { name: '合成员工', code: `OF_${uniqueSuffix()}` });
  const manager = await employee();
  const hrbp = await employee();
  const [level] = rows<{ id: string }>(
    await withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO job_level_objects(tenant_id) VALUES (${member.tenant.id}) RETURNING id`),
    ),
  );
  const [company] = rows<{ id: string }>(
    await withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`INSERT INTO contract_companies(tenant_id, code, name)
        VALUES (${member.tenant.id}, ${`C${uniqueSuffix()}`}, '合成法人') RETURNING id`),
    ),
  );
  const request = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/offers${path}`, { ...as, ...options });

  /** 社招必填 10 项（OF-R1）。 */
  const socialFields = () => ({
    channelName: '内推',
    name: '合成候选人',
    personalEmail: `of-${uniqueSuffix()}@example.com`,
    departmentId: department.id,
    plannedEntryDate: '2026-11-01',
    levelId: level!.id,
    directManagerId: manager.id,
    hrbpId: hrbp.id,
    costCenter: 'CC-001',
    contractCompanyId: company!.id,
  });
  const internFields = () => ({
    name: '合成实习生',
    personalEmail: `of-${uniqueSuffix()}@example.com`,
    departmentId: department.id,
    plannedEntryDate: '2026-11-01',
  });
  async function create(body: Record<string, unknown>): Promise<OfferBody> {
    const response = await request('POST', '', { ifMatch: 0, body });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as OfferBody;
  }
  const social = (extra: Record<string, unknown> = {}) => create({ entry: 'offer', ...socialFields(), ...extra });
  const intern = (extra: Record<string, unknown> = {}) => create({ entry: 'intern', ...internFields(), ...extra });
  async function get(id: string): Promise<OfferBody> {
    const response = await request('GET', `/${id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as OfferBody;
  }
  /** 可信造数：直接改状态（已发、失效等 C2 / BE-14b 才有入口的状态）。 */
  const force = (id: string, column: string, value: string) =>
    withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET ${sql.identifier(column)} = ${value} WHERE id = ${id}`),
    );
  const invalidated = (id: string) =>
    withTenant(db, member.tenant.id, (tx) =>
      tx.execute(sql`UPDATE offers SET status = 'invalid', invalid_reason_code = 'candidate_gave_up',
        invalid_at = now() WHERE id = ${id}`),
    );
  async function list(query: string) {
    const response = await request('GET', `?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { total: number; items: OfferBody[] };
  }
  return {
    db,
    ...member,
    department,
    manager,
    hrbp,
    level: level!,
    company: company!,
    request,
    seeder,
    socialFields,
    internFields,
    create,
    social,
    intern,
    get,
    force,
    invalidated,
    list,
  };
}

export type OfferWorld = Awaited<ReturnType<typeof offerWorld>>;

export const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;
