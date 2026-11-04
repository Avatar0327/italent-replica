/**
 * F-465a 人事报表目录与 8 张名册分析报表的验收夹具（规格 35 §2.1 预置报表 1.01 / 1.04～1.08 / 1.1.01 / 1.1.02）：
 * 底座沿用 BE-13b 的 movementWorld（租户今天 = 2026-10-06，含实习生 / 外部人员 / 离职 / 退休 / 调动 / 转正），
 * 另加合同、兼职任职，以及可按“人员范围 / 对象拒绝 / 字段隐藏”裁剪的受限入口。期望值一律手写。
 */
import './support/exit-gate-enforced.js';
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import type { Db } from '@italent/db';
import { expect } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { movementWorld, MOVEMENT_TODAY } from './AC-HA-13b-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';

export const REPORTS_BASE = '/api/tenant/hr-analysis/reports';
export const ROSTER_OBJECT = 'TenantBase.HrRoster';
export const RECORD_OBJECT = MODULE_OBJECTS.employmentRecord.code;
export const CONTRACT_OBJECT = MODULE_OBJECTS.contract.code;
export const PERSON_OBJECT = PERSONNEL_OBJECT;
export const NEW_REPORT_CODES = ['1.01', '1.04', '1.05', '1.06', '1.07', '1.08', '1.1.01', '1.1.02'] as const;
export type NewReportCode = (typeof NEW_REPORT_CODES)[number];
export const AS_OF = MOVEMENT_TODAY;
/** 1.07 的默认时间范围：覆盖 2026 全年至租户今天。 */
export const RANGE = 'from=2026-01-01&to=2026-10-06';

export interface ReportPage {
  asOf?: string;
  code: string;
  name: string;
  items: Record<string, unknown>[];
  columns: { key: string; label: string }[];
  total: number;
  page: number;
  pageSize: number;
  hasDataPermission: boolean;
}
export interface CatalogItem {
  code: string;
  name: string;
  group: string;
  endpoint: string;
  available: boolean;
  reason?: string;
}

export const allow: Authorizer = () => true;
/** 只拒绝指定对象的查看 / 按钮权（其余放行）。 */
export const deny =
  (...resources: string[]): Authorizer =>
  (request) =>
    !(resources.includes(String(request.resource)) && ['object.view', 'object.button'].includes(request.action));

export async function reportsWorld(db: Db) {
  const w = await movementWorld(db);
  const { p, A1, B } = w;
  const api = tenantApi(db, { clock: () => new Date(`${MOVEMENT_TODAY}T01:00:00Z`) });
  const as = { user: w.who.user, tenant: w.tenantId };

  // ---- 合同：old 签订；reg 签订后续签；base 签订（用于范围外）----
  const kind = async (path: string, name: string) => {
    const response = await w.call('POST', `/api/tenant/contracts/master-data/${path}`, {
      ifMatch: 0,
      body: { code: `F465_${uniqueSuffix()}`, name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  };
  const contractType = await kind('types', '劳动合同');
  const company = await kind('companies', '合成法人公司');
  async function contract(
    employeeId: string,
    fields: { effectiveDate: string; endDate: string },
    renewing?: { id: string; revision: number },
  ) {
    const response = await w.call('POST', '/api/tenant/contracts/commands', {
      ifMatch: renewing?.revision ?? 0,
      body: {
        operation: renewing ? 'renew' : 'create',
        mode: 'direct',
        employeeId,
        ...(renewing ? { targetId: renewing.id } : {}),
        fields: {
          typeId: contractType.id,
          companyId: company.id,
          termType: 'fixed',
          termMonths: 12,
          signingDate: fields.effectiveDate,
          ...fields,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  }
  const oldContract = await contract(p.old.id, { effectiveDate: '2026-01-01', endDate: '2026-12-31' });
  const regFirst = await contract(p.reg.id, { effectiveDate: '2025-02-01', endDate: '2026-01-31' });
  const regRenewed = await contract(p.reg.id, { effectiveDate: '2026-02-01', endDate: '2027-01-31' }, regFirst);
  const baseContract = await contract(p.base.id, { effectiveDate: '2026-09-01', endDate: '2027-08-31' });

  // ---- 兼职任职：old 一条（范围内）、base 一条（范围外）----
  async function partTime(employeeId: string, startDate: string, department: { id: string }) {
    const employee = await w.x.session.getEmployee(employeeId);
    const response = await w.x.session.request('POST', `/employees/${employeeId}/part-times`, {
      ifMatch: employee.revision,
      body: { partTimeType: 'part_time', startDate, fields: { departmentId: department.id } },
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  await partTime(p.old.id, '2026-09-10', B);
  await partTime(p.base.id, '2026-09-15', A1);

  /**
   * 受限入口：authorize 自定义；personIds 给出时数据范围只含这些人（空数组 = 范围为空，fail-closed），否则看全部；
   * hidden 按对象摘掉可见字段（缺省全部可见）。
   */
  function restricted(
    base: Authorizer,
    options: { personIds?: readonly string[]; hidden?: Readonly<Record<string, readonly string[]>> } = {},
  ) {
    const authorize: Authorizer = (request) => base(request);
    const scope = options.personIds
      ? options.personIds.length
        ? {
            ...EMPTY_SCOPE,
            hasDataPermission: true,
            terms: [{ dimension: 'management' as const, orgIds: [], personIds: options.personIds }],
          }
        : { ...EMPTY_SCOPE }
      : { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
    registerScopeProvider(authorize, {
      scope: async () => scope,
      authorize: async (request) => authorize(request),
      fields: async (_tenantId, _userId, objectCode) => {
        const all = [...PERSONNEL_OBJECTS, MODULE_OBJECTS.employmentRecord, MODULE_OBJECTS.contract]
          .find((definition) => definition.code === objectCode)!
          .fields.map((field) => field.code);
        return new Set(all.filter((field) => !options.hidden?.[objectCode]?.includes(field)));
      },
    });
    const scoped = tenantApi(db, { authorize, clock: () => new Date(`${MOVEMENT_TODAY}T01:00:00Z`) });
    return (path: string) => scoped.request('GET', path, as);
  }
  const full = restricted(allow);

  const query = (parts: (string | undefined)[]) => parts.filter(Boolean).join('&');
  const reportPath = (code: string, ...parts: (string | undefined)[]) => `${REPORTS_BASE}/${code}?${query(parts)}`;
  async function report(
    code: string,
    parts: (string | undefined)[] = [],
    request: (path: string) => Promise<Response> = full,
  ) {
    const response = await request(reportPath(code, ...parts));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as ReportPage;
  }
  const exported = (code: string, parts: (string | undefined)[] = [], request = full) =>
    request(`${REPORTS_BASE}/${code}/export?${query(parts)}`);
  const catalog = async (request = full) => {
    const response = await request(REPORTS_BASE);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { items: CatalogItem[] };
  };
  /** 报表行的工号列（所有报表都有固定列“工号”）。 */
  const codesOf = (page: ReportPage) => page.items.map((item) => String(item.code));

  return {
    ...w,
    as,
    api,
    contract,
    contracts: { old: oldContract, regFirst, regRenewed, base: baseContract },
    restricted,
    full,
    report,
    reportPath,
    exported,
    catalog,
    codesOf,
  };
}
export type ReportsWorld = Awaited<ReturnType<typeof reportsWorld>>;
