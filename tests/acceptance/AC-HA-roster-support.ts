/**
 * BE-12a 时点员工花名册验收夹具（docs/02_业务建模/35 §2.2、AC-HA-03 / AC-HA-05）：
 * 在撤销离职夹具（cancelWorld：已入职员工、可信离职端口、撤销离职）之上加：多级组织、带档案字段的入职、直接调动、
 * 合同主数据与合同命令、组织改名，以及花名册的读取与受限授权入口。固定日期，不用随机日期。
 */
import type { Authorizer } from '@italent/api';
import { MODULE_OBJECTS, PERSONNEL_OBJECT, PERSONNEL_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import type { Db } from '@italent/db';

export const ROSTER_OBJECT = 'TenantBase.HrRoster';
export const PERSON_OBJECT = PERSONNEL_OBJECT;
export const RECORD_OBJECT = MODULE_OBJECTS.employmentRecord.code;
export const CONTRACT_OBJECT = MODULE_OBJECTS.contract.code;
const BASE = '/api/tenant/hr-analysis/roster';

/** 原站时点员工花名册的列顺序（规格 35 §2.2、总编排补充 4）；CSV 表头在“姓名 / 工号”两列之后依序排列。 */
export const ROSTER_HEADERS = [
  '职级',
  '性别',
  '出生日期',
  '年龄',
  '最高学历',
  '毕业学校名称',
  '毕业时间',
  '专业',
  '手机',
  '证件号码',
  '个人邮箱',
  '籍贯',
  '户籍所在地',
  '户口类别',
  '民族',
  '婚姻状况',
  '政治面貌',
  '入党/团日期',
  '参加工作日期',
  '紧急联系人',
  '与本人关系',
  '紧急联系人电话',
  '入职日期',
  '开始日期',
  '结束日期',
  '直线经理',
  '直线经理邮箱',
  '人员类别',
  '累计司龄（年）',
  '累计工龄（年）',
  '工作地点',
  '用工形式',
  '人员状态',
  '是否有试用期',
  '试用开始日期',
  '预计试用结束日期',
  '试用期(月)',
  '转正日期',
  '最后工作日',
  '组织全称',
  '一级组织',
  '二级组织',
  '三级组织',
  '合同类型',
  '合同期限类型',
  '合同生效日期',
  '合同终止日期',
  '合同期限（月）',
  '实际终止时间',
] as const;

export interface RosterItem {
  employeeId: string;
  employeeName: string;
  code: string;
  [key: string]: unknown;
}
export interface RosterPage {
  items: RosterItem[];
  columns: { key: string; label: string }[];
  total: number;
  page: number;
  pageSize: number;
  asOf: string;
  hasDataPermission: boolean;
}

export interface Profile {
  readonly gender?: string;
  readonly birthday?: string;
  readonly workDate?: string;
  readonly mobilePhone?: string;
  readonly idNumber?: string;
  readonly email?: string;
  readonly [key: string]: unknown;
}

export async function rosterWorld(db: Db, label: string, today = '2026-10-06') {
  const x = await cancelWorld(db, label, today);
  const tenantId = x.session.tenant.id;
  const as = { user: x.session.user.id, tenant: tenantId };
  const api = tenantApi(db, { clock: () => new Date(`${today}T01:00:00Z`) });
  const call = (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, path, { ...as, ...init });

  /** 多级组织：一级 = 租户根下的第一层。 */
  async function org(name: string, parent?: { id: string }) {
    return x.session.org(name, {
      establishedOn: '2024-01-01',
      ...(parent ? { parents: { admin: { parentId: parent.id } } } : {}),
    });
  }
  async function rename(target: { id: string; revision: number }, name: string, effectiveDate: string) {
    const response = await call('PATCH', `/api/tenant/org/organizations/${target.id}`, {
      ifMatch: target.revision,
      body: { name, effectiveDate, addEmployment: false },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 建档（指定工号，默认排序用）+ 档案字段 + 直接入职。 */
  async function hire(code: string, name: string, date: string, department: { id: string }, profile: Profile = {}) {
    const employee = await x.session.employee(name, code);
    const business = await x.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: date, fields: { departmentId: department.id } },
      employee.revision,
    );
    expect(business.status).toBe('effective');
    if (Object.keys(profile).length) await patchProfile(employee.id, profile);
    return employee;
  }
  async function patchProfile(employeeId: string, profile: Profile) {
    const current = (await (await call('GET', `/api/tenant/personnel/employees/${employeeId}`)).json()) as {
      revision: number;
    };
    const response = await call('PATCH', `/api/tenant/personnel/employees/${employeeId}`, {
      ifMatch: current.revision,
      body: profile,
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 合同主数据与合同命令（同 AC-CT-support 的写法）。 */
  const contractCall = (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
    call(method, `/api/tenant/contracts${path}`, init);
  async function master(kind: 'types' | 'companies', name: string) {
    const response = await contractCall('POST', `/master-data/${kind}`, {
      ifMatch: 0,
      body: { code: `M_${uniqueSuffix()}`, name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  const contractType = await master('types', '劳动合同');
  const company = await master('companies', '合成法人公司');
  async function contract(
    employeeId: string,
    fields: { effectiveDate: string; endDate: string; termMonths?: number },
    renewing?: { id: string; revision: number },
  ) {
    const response = await contractCall('POST', '/commands', {
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
          termMonths: fields.termMonths ?? 12,
          signingDate: fields.effectiveDate,
          ...fields,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number };
  }

  const roster = (asOf: string | undefined, query = '', request = call) =>
    request('GET', `${BASE}?${[asOf ? `asOf=${asOf}` : '', query].filter(Boolean).join('&')}`);
  async function rosterOk(asOf: string | undefined, query = '', request = call) {
    const response = await roster(asOf, query, request);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as RosterPage;
  }
  const exported = (asOf: string, query = '', request = call) =>
    request('GET', `${BASE}/export?asOf=${asOf}${query ? `&${query}` : ''}`);
  const codes = (page: RosterPage) => page.items.map((item) => item.code);

  /**
   * 受限入口：authorize 自定义；personIds 给出时数据范围只含这些人（管理单元内人员，AC-HA-05），否则看全部；
   * hidden 按对象摘掉可见字段（缺省全部可见）。
   */
  function restricted(
    base: Authorizer,
    options: { personIds?: readonly string[]; hidden?: Readonly<Record<string, readonly string[]>> } = {},
  ) {
    // 范围提供者按授权器函数登记：每次调用包一层新函数，避免共用同一个 allow 时互相覆盖
    const authorize: Authorizer = (request) => base(request);
    const scope = options.personIds
      ? {
          ...EMPTY_SCOPE,
          hasDataPermission: true,
          terms: [{ dimension: 'management' as const, orgIds: [], personIds: options.personIds }],
        }
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
    const restrictedApi = tenantApi(db, { authorize, clock: () => new Date(`${today}T01:00:00Z`) });
    return (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
      restrictedApi.request(method, path, { ...as, ...init });
  }

  return {
    ...x,
    db,
    as,
    call,
    org,
    rename,
    hire,
    patchProfile,
    contract,
    contractType,
    roster,
    rosterOk,
    exported,
    codes,
    restricted,
    base: BASE,
  };
}
export type RosterWorld = Awaited<ReturnType<typeof rosterWorld>>;

/** 解析 CSV（带引号、引号转义、BOM 已由调用方判断）。 */
export function parseCsv(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      lines.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    lines.push(row);
  }
  return lines;
}

/** 去掉 UTF-8 BOM（导出文件的第一个字符）。 */
export const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
