/**
 * R2-T04 BE-5b 验收夹具：退休同时返聘（docs/08_设计/R2-T04_退休设计.md §8）。
 * 在退休夹具之上加：返聘计划请求体、专用入口调用、周期 / 合同 / 账号 / 组织负责人读取。
 * 返聘日 R = E′ + 1（DEC-637 A-1），夹具里的期望日期都按这个口径手算，不调用产品里的 retireRehireStartDate。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Db } from '@italent/db';
import { expect } from 'vitest';
import { tenantApi } from './support/tenant-api.js';
import { retirementWorld, type RetirementWorld } from './AC-RT-support.js';

export interface RehirePlanOptions {
  readonly departmentId?: string;
  readonly contract?: Record<string, unknown> | null;
  readonly entry?: Record<string, unknown>;
  readonly fields?: Record<string, unknown>;
}

/** 在任一退休可用的夹具（含撤销夹具）之上叠加返聘辅助。 */
export function withRehire<W extends RetirementWorld>(db: Db, x: W, today = '2026-10-06') {
  const tenantId = x.session.tenant.id;
  const rows = <T>(statement: ReturnType<typeof sql>) => x.sqlRows<T>(statement);

  /** 合同模块的合成法人公司与合同类型；返聘合同计划只能引用已存在的主数据。 */
  async function contractMaster() {
    const response = await x.contracts('POST', '/master-data/companies', {
      ifMatch: 0,
      body: { code: randomUUID(), name: '合成返聘公司' },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const company = (await response.json()) as { id: string };
    return { companyId: company.id, typeId: await x.contractType('合成返聘合同类型') };
  }

  /** 返聘合同计划（不含生效日：起始日由返聘日决定）。 */
  const contractPlan = (master: { companyId: string; typeId: string }, extra: Record<string, unknown> = {}) => ({
    typeId: master.typeId,
    companyId: master.companyId,
    endDate: '2028-12-31',
    termType: 'fixed',
    termMonths: 24,
    signingDate: '2026-09-20',
    ...extra,
  });

  /** 返聘计划：新任职的部门默认取调入部门（与退休前部门不同，便于断言）。 */
  const rehirePlan = (options: RehirePlanOptions = {}) => ({
    fields: { employType: 'internal', departmentId: options.departmentId ?? x.to.id, ...(options.fields ?? {}) },
    entry: options.entry ?? { probation: false },
    ...(options.contract ? { contract: options.contract } : {}),
  });

  /** 专用入口 POST retirements/employees/:id 的同时返聘请求体。 */
  const rehireBody = (
    lastWorkDate: string,
    mode: 'application' | 'direct' = 'direct',
    plan: object = rehirePlan(),
    extra: object = {},
  ) => ({ mode, lastWorkDate, reEmployed: true, rehire: plan, ...extra });

  async function postRehire(body: object, employeeId = x.employee.id, request = x.session.request) {
    const { revision } = await x.session.getEmployee(employeeId);
    return request('POST', `/retirements/employees/${employeeId}`, { ifMatch: revision, body });
  }

  async function createdRehire(body: object, employeeId = x.employee.id) {
    const response = await postRehire(body, employeeId);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string };
  }

  const extension = async (businessId: string) =>
    (
      await rows<{
        re_employed: boolean;
        rehire_plan: Record<string, unknown> | null;
        rehire_business_id: string | null;
      }>(sql`SELECT re_employed, rehire_plan, rehire_business_id FROM retirement_requests
        WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`)
    )[0];

  const cycles = (employeeId = x.employee.id) =>
    rows<{ entry_type: string; entry_date: string }>(sql`SELECT entry_type, entry_date::text FROM employment_cycles
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY entry_date`);

  const accountLinks = (employeeId = x.employee.id) =>
    rows<{ user_id: string }>(sql`SELECT user_id::text FROM permission_user_person_links
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY user_id`);

  const contractStarts = () =>
    rows<{ id: string; status: string; effective_date: string; actual: string | null }>(sql`
      SELECT id, status, effective_date::text, actual_termination_date::text AS actual FROM contract_records
      WHERE tenant_id=${tenantId} AND employee_id=${x.employee.id}::uuid AND deleted=false
      ORDER BY effective_date, id`);

  const contractRequestsOf = () =>
    rows<{ id: string; operation: string; status: string; mode: string; effective_date: string }>(sql`
      SELECT id, operation, status, mode, effective_date::text FROM contract_requests
      WHERE tenant_id=${tenantId} AND employee_id=${x.employee.id}::uuid ORDER BY effective_date, id`);

  const rehireEffects = (businessId: string) =>
    rows<{ target_id: string | null; detail: Record<string, unknown> }>(sql`
      SELECT target_id, detail FROM exit_effects WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid
        AND kind='rehire_created'`);

  /** 组织负责人走组织接口设置，读取取最新组织版本。 */
  async function setHead(org: { id: string }, personId: string) {
    const api = tenantApi(db, { clock: () => new Date(`${today}T01:00:00Z`) });
    const as = { user: x.session.user.id, tenant: tenantId };
    const current = await api.request('GET', `/api/tenant/org/organizations/${org.id}`, as);
    expect(current.status).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const response = await api.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
      ...as,
      ifMatch: revision,
      body: { effectiveDate: '2026-09-01', personInChargeId: personId },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const headOf = async (orgId: string) =>
    (
      await rows<{ head: string | null }>(sql`SELECT person_in_charge_id::text AS head FROM org_versions
        WHERE tenant_id=${tenantId} AND org_id=${orgId}::uuid ORDER BY version_no DESC LIMIT 1`)
    )[0]!.head;

  return {
    ...x,
    contractMaster,
    contractPlan,
    rehirePlan,
    rehireBody,
    postRehire,
    createdRehire,
    extension,
    cycles,
    accountLinks,
    contractStarts,
    contractRequestsOf,
    rehireEffects,
    setHead,
    headOf,
  };
}

export async function rehireWorld(db: Db, label: string, today = '2026-10-06') {
  return withRehire(db, await retirementWorld(db, label, today), today);
}

export type RehireWorld = Awaited<ReturnType<typeof rehireWorld>>;
