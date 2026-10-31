/**
 * BE-13a 人事分析第 2 段验收夹具（规格 35“补充：BE-13…”B49 / B55，“员工结构两张报表”B53）：
 * 看板 / 报表接口的客户端、“数字 = 明细”断言、受限授权入口，以及一套固定的组织 / 人员 / 合同造数。
 * 期望值一律是手写的 ID 集合与数字，不拿实现自己的谓词当参照；固定日期（租户今天 = 2026-10-01），不用随机日期。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { EMP_TODAY, employmentSession, type Employee } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const STRUCTURE_BASE = '/api/tenant/analytics/hr-structure';
export const CONTRACT_BOARD_BASE = '/api/tenant/analytics/contract-board';
export const TODAY = EMP_TODAY;
const LONG_AGO = '2000-01-01';

export interface Group {
  key: string;
  label: string;
  count: number;
  total?: number;
  ratio?: number | null;
}
export interface Component {
  code: string;
  name: string;
  kind: string;
  value: number | null;
  count?: number;
  groups: Group[] | null;
}
export interface Board {
  asOf: string;
  hasDataPermission: boolean;
  components: Component[];
}
export interface DetailPage {
  asOf: string;
  code: string;
  total: number;
  items: { id: string; employeeId: string | null; organizationId: string | null }[];
  page: number;
  pageSize: number;
  hasDataPermission: boolean;
}
export interface Report {
  asOf: string;
  report: string;
  name: string;
  employType: string;
  hasDataPermission: boolean;
  columns: { key: string; label: string }[];
  rows: { organizationId: string; organizationName: string; cells: Record<string, number | null> }[];
  summary: { cells: Record<string, number | null> };
}

export const sorted = (ids: readonly string[]) => [...ids].sort();
export const ids = (...people: readonly { id: string }[]) => sorted(people.map((person) => person.id));

/** 看板 / 报表客户端：base 选人员结构或合同看板；filters 是看板级筛选的查询串（不含 asOf）。 */
export function boardClient(db: Db, who: { tenant: string; user: string }, authorize?: Authorizer) {
  const api = tenantApi(db, {
    clock: () => new Date(`${TODAY}T01:00:00Z`),
    ...(authorize ? { authorize } : {}),
  });
  const get = (path: string) => api.request('GET', path, { user: who.user, tenant: who.tenant });
  const qs = (...parts: (string | undefined)[]) => parts.filter(Boolean).join('&');

  async function json<T>(path: string): Promise<T> {
    const response = await get(path);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as T;
  }
  const board = (base: string, filters = '') => json<Board>(`${base}?${filters}`);
  const component = async (base: string, code: string, filters = '') =>
    (await board(base, filters)).components.find((item) => item.code === code)!;
  /** 把明细翻页读完（pageSize 2，顺带覆盖分页），返回 ID 与服务端报的总数。 */
  async function detail(base: string, code: string, filters = '', group?: string) {
    const read: string[] = [];
    let total = 0;
    for (let page = 1; page < 50; page++) {
      const query = qs(filters, group === undefined ? '' : `group=${encodeURIComponent(group)}`, `page=${page}`);
      const body = await json<DetailPage>(`${base}/components/${encodeURIComponent(code)}?${query}&pageSize=2`);
      total = body.total;
      read.push(...body.items.map((item) => item.id));
      if (body.items.length < 2) break;
    }
    expect(new Set(read).size, `${code} 明细 ID 不重复`).toBe(read.length);
    return { ids: sorted(read), total };
  }
  /** 数字 = 明细条数 = 期望集合（group 缺省 = 组件的数值，平均值类取样本数；给出时 = 该分组的人数）。 */
  async function expectCount(base: string, code: string, expected: readonly string[], filters = '', group?: string) {
    const item = await component(base, code, filters);
    const whole = item.kind === 'average' ? item.count : item.value;
    const shown = group === undefined ? whole : (item.groups?.find((g) => g.key === group)?.count ?? 0);
    const read = await detail(base, code, filters, group);
    expect(
      { shown, total: read.total, ids: read.ids },
      `${code}${group ? `/${group}` : ''} 数字 / 总数 / 明细`,
    ).toEqual({
      shown: expected.length,
      total: expected.length,
      ids: sorted(expected),
    });
  }
  const report = (code: string, filters = '') => json<Report>(`${STRUCTURE_BASE}/reports/${code}?${filters}`);
  return { api, get, board, component, detail, expectCount, report };
}
export type BoardClient = ReturnType<typeof boardClient>;

/** 受限授权：deny 给出的“对象查看”被拒；scope 给出时用它作数据范围，否则看全部。 */
export function restrictedAuthorizer(options: { deny?: string; scope?: ModuleScope }) {
  const authorize: Authorizer = (request) => !(request.action === 'object.view' && request.resource === options.deny);
  const scope = options.scope ?? { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
  registerScopeProvider(authorize, {
    scope: async () => scope,
    authorize: async (request) => authorize(request),
    fields: async () => new Set(),
  });
  return authorize;
}
/** HRBP 的管理单元范围（AC-HA-05 同口径）：管理单元内组织，及其中按 asOf 任职的人员。 */
export const managementScope = (tenantId: string, orgIds: string[]): ModuleScope => ({
  ...EMPTY_SCOPE,
  hasDataPermission: true,
  orgIds,
  terms: [
    {
      dimension: 'management',
      orgIds,
      personIds: [],
      personQuery: { kind: 'organization', tenantId, asOf: TODAY },
    },
  ],
});

/** 档案字段（性别 / 出生日期 / 最高学历）与任职字段。 */
export interface PersonSpec {
  readonly date: string;
  readonly department: { id: string };
  readonly profile?: { gender?: string; birthday?: string; educationLevel?: string };
  readonly fields?: Record<string, unknown>;
  readonly probationMonths?: number;
}

export async function structureWorld(db: Db, label: string) {
  const session = await employmentSession(db, `${label}-${uniqueSuffix()}`);
  const tenantId = session.tenant.id;
  const who = { tenant: tenantId, user: session.user.id };
  const api = tenantApi(db, { clock: () => new Date(`${TODAY}T01:00:00Z`) });
  const call = (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...init, user: who.user, tenant: who.tenant });

  async function org(name: string, parent?: { id: string }, broadType?: string) {
    return session.org(name, {
      establishedOn: LONG_AGO,
      ...(parent ? { parents: { admin: { parentId: parent.id } } } : {}),
      ...(broadType ? { broadType } : {}),
    });
  }
  async function job(kind: 'sequences' | 'levels', name: string, extra: Record<string, unknown> = {}) {
    const response = await call('POST', `/api/tenant/job/${kind}`, {
      ifMatch: 0,
      body: { name, code: `HA13A_${randomUUID().replaceAll('-', '')}`, startDate: LONG_AGO, ...extra },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  async function patchProfile(employeeId: string, profile: Record<string, unknown>) {
    const current = (await (await call('GET', `/api/tenant/personnel/employees/${employeeId}`)).json()) as {
      revision: number;
    };
    const response = await call('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
      ifMatch: current.revision,
      body: profile,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  /** 直接入职（内部员工，除非 fields 另给 employType）；probationMonths 给出时带试用期（人员状态 = 试用）。 */
  async function hire(name: string, spec: PersonSpec): Promise<Employee> {
    const employee = await session.employee(name);
    const business = await session.business(
      employee.id,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: spec.date,
        fields: { employType: 'internal', departmentId: spec.department.id, ...spec.fields },
        ...(spec.probationMonths ? { probation: true, probationMonths: spec.probationMonths } : {}),
      },
      employee.revision,
    );
    expect(business.status).toBe('effective');
    if (spec.profile && Object.keys(spec.profile).length) await patchProfile(employee.id, spec.profile);
    return employee;
  }
  const sqlRows = <T>(query: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => {
      const result = await tx.execute(query);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
    });

  return { db, session, tenantId, who, call, org, job, hire, patchProfile, sqlRows };
}
export type StructureWorld = Awaited<ReturnType<typeof structureWorld>>;

/** 合同主数据与合同命令（同 AC-HA-roster-support / AC-CT-support 的写法）。 */
export async function contractKit(w: StructureWorld) {
  const contractCall = (method: string, path: string, init: Parameters<StructureWorld['call']>[2] = {}) =>
    w.call(method, `/api/tenant/contracts${path}`, init);
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await contractCall('POST', `/master-data/${kind}`, {
      ifMatch: 0,
      body: { code: `M_${uniqueSuffix()}`, name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  async function command(body: Record<string, unknown>, revision = 0) {
    const response = await contractCall('POST', '/commands', { ifMatch: revision, body: { mode: 'direct', ...body } });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  }
  /** 本人某类操作的合同申请单 ID（已生效）。 */
  async function requestIds(employeeId: string, operation: string) {
    const rows = await w.sqlRows<{ id: string }>(sql`SELECT id::text FROM contract_requests
      WHERE tenant_id=${w.tenantId} AND employee_id=${employeeId}::uuid AND operation=${operation}`);
    return rows.map((row) => row.id);
  }
  /** 直接造一张申请单（状态由审批中心推进，这里只要状态与操作类型），返回 ID。 */
  async function rawRequest(
    employeeId: string,
    target: { id: string } | null,
    values: { operation: string; status: string; typeId: string; companyId: string; effectiveDate: string },
  ) {
    const id = randomUUID();
    await w.sqlRows(sql`INSERT INTO contract_requests(id,tenant_id,employee_id,number,type_id,company_id,term_type,
        effective_date,end_date,signing_count,operation,mode,status,created_by,target_id)
      VALUES (${id}::uuid,${w.tenantId},${employeeId}::uuid,${`REQ-${randomUUID()}`},${values.typeId}::uuid,
        ${values.companyId}::uuid,'fixed',${values.effectiveDate}::date,'2027-12-31',1,${values.operation},
        'application',${values.status},${w.who.user}::uuid,${target?.id ?? null}::uuid)`);
    return id;
  }
  return { master, command, requestIds, rawRequest };
}
