/**
 * R1-T10 调动跨对象联动验收夹具：在 R1-T08 定时生效夹具上加合同主数据与联动接口。
 * 调动经 HR 调动入口（/transfers/employees/:id）带 linkage 保存；定时任务、审批端口沿用 activationWorld。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { expect } from 'vitest';
import type { Authorizer } from '@italent/api';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { activationWorld } from './AC-TRF-activation-support.js';
import { tenantApi, type RequestOptions } from './support/tenant-api.js';

export const D = '2026-10-10';

export interface LinkageItem {
  readonly id: string;
  readonly revision: number;
  readonly itemType: 'duty_subordinate' | 'duty_org_role' | 'part_time_end';
  readonly subordinateId: string | null;
  readonly orgId: string | null;
  readonly orgRole: string | null;
  readonly relation: string | null;
  readonly receiverId: string | null;
  readonly partTimeRecordId: string | null;
  readonly effectiveDate: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly attemptCount: number;
  readonly failure: { readonly code: string; readonly message: string; readonly rule: string | null } | null;
}

export interface LinkageView {
  readonly businessId: string;
  readonly options: Record<string, unknown>;
  readonly executedAt: string | null;
  readonly contract: { readonly beforeContractId: string; readonly afterContractId: string } | null;
  readonly onTrial: {
    readonly startDate: string;
    readonly months: number;
    readonly expectedEndDate: string;
    readonly status: string;
  } | null;
  readonly handover: {
    readonly handoverPersonId: string | null;
    readonly handoverStatus: string;
    readonly approvalStatus: string | null;
  } | null;
  readonly salaryReminder: { readonly status: string; readonly createdAt: string } | null;
  readonly dutyTransfer: {
    readonly total: number;
    readonly subordinateCount: number;
    readonly orgRoleCount: number;
    readonly failedCount: number;
    readonly items: LinkageItem[];
  } | null;
  readonly partTimes: LinkageItem[];
}

export interface ContractRow {
  readonly id: string;
  readonly revision: number;
  readonly employeeId: string;
  readonly typeId: string;
  readonly status: string;
  readonly approvalStatus: string;
  readonly effectiveDate: string;
  readonly endDate: string | null;
  readonly actualTerminationDate: string | null;
  readonly previousContractId: string | null;
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export async function linkageWorld(db: Db, label: string) {
  const w = await activationWorld(db, label);
  const api = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  const contractRequest = (method: string, path: string, options: RequestOptions = {}) =>
    api.request(method, `/api/tenant/contracts${path}`, { ...options, ...as });
  async function master(kind: string, name: string) {
    const response = await contractRequest('POST', `/master-data/${kind}`, {
      ifMatch: 0,
      body: { code: randomUUID(), name },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  const type = await master('types', '劳动合同');
  const otherType = await master('types', '劳务合同');
  const company = await master('companies', '合成法人公司');
  return {
    ...w,
    api,
    as,
    type,
    otherType,
    company,
    contractRequest,
    ...helpers(w, contractRequest, type, company, api),
  };
}

export type LinkageWorld = Awaited<ReturnType<typeof linkageWorld>>;

function helpers(
  w: Awaited<ReturnType<typeof activationWorld>>,
  contractRequest: (method: string, path: string, options?: RequestOptions) => Promise<Response>,
  type: { id: string },
  company: { id: string },
  orgApi: ReturnType<typeof tenantApi>,
) {
  const tenantId = w.session.tenant.id;

  /** 在调出部门入职，可指定直线经理（下属 / 接收人）。 */
  async function hire(name: string, fields: Record<string, unknown> = {}, departmentId = w.from.id) {
    const employee = await w.session.employee(name);
    const hire = await w.session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: '2026-09-01', fields: { departmentId, ...fields } },
      employee.revision,
    );
    return { employee, hire };
  }

  async function contract(employeeId: string, extra: Record<string, unknown> = {}, mode = 'direct') {
    const response = await contractRequest('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode,
        employeeId,
        fields: {
          typeId: type.id,
          companyId: company.id,
          effectiveDate: '2026-09-01',
          endDate: '2028-08-31',
          termType: 'fixed',
          termMonths: 24,
          signingDate: '2026-08-25',
          ...extra,
        },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as ContractRow & { status: string };
  }

  async function contracts(employeeId: string): Promise<ContractRow[]> {
    return withTenant(w.db, tenantId, async (tx) =>
      rows<ContractRow>(
        await tx.execute(sql`SELECT id, revision, employee_id AS "employeeId", type_id AS "typeId", status,
          approval_status AS "approvalStatus", effective_date::text AS "effectiveDate", end_date::text AS "endDate",
          actual_termination_date::text AS "actualTerminationDate", previous_contract_id AS "previousContractId"
        FROM contract_records WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND NOT deleted
        ORDER BY created_at, version_no`),
      ),
    );
  }

  async function contractChanges(employeeId: string) {
    return withTenant(w.db, tenantId, async (tx) =>
      rows<{ beforeContractId: string; afterContractId: string }>(
        await tx.execute(sql`SELECT before_contract_id AS "beforeContractId", after_contract_id AS "afterContractId"
        FROM contract_changes WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid`),
      ),
    );
  }

  /** HR 调动入口：缺省为跨部门调动到调入部门，D 生效。 */
  function transfer(
    person: { employee: { id: string } },
    body: Record<string, unknown>,
    revision?: number,
  ): Promise<Response> {
    return (async () => {
      const current = revision ?? (await w.session.getEmployee(person.employee.id)).revision;
      return w.session.request('POST', `/transfers/employees/${person.employee.id}`, {
        ifMatch: current,
        body: {
          initiator: 'hr',
          transferTypeCode: 'cross_department',
          mode: 'application',
          submit: true,
          effectiveDate: D,
          fields: { departmentId: w.to.id },
          ...body,
        },
      });
    })();
  }

  async function saved(response: Response) {
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string };
  }

  async function linkage(businessId: string): Promise<LinkageView> {
    const response = await w.session.request('GET', `/transfers/${businessId}/linkage`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as LinkageView;
  }

  function retryItem(item: { id: string; revision: number }, idempotencyKey?: string) {
    return w.session.request('POST', `/transfers/linkage-items/${item.id}/retry`, {
      ifMatch: item.revision,
      body: {},
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async function orgPeople(orgId: string) {
    return withTenant(w.db, tenantId, async (tx) => {
      const [row] = rows<{ head: string | null; shop: string | null; hrbp: string | null }>(
        await tx.execute(sql`SELECT person_in_charge_id AS head, shop_owner_id AS shop, hrbp_id AS hrbp
        FROM org_versions WHERE tenant_id=${tenantId} AND org_id=${orgId}::uuid ORDER BY version_no DESC LIMIT 1`),
      );
      return row!;
    });
  }

  /** 组织负责人走组织接口设置（组织版本切分由 R1-T03 负责）。 */
  async function setHead(org: { id: string }, personId: string) {
    const as = { user: w.session.user.id, tenant: tenantId };
    const current = await orgApi.request('GET', `/api/tenant/org/organizations/${org.id}`, as);
    expect(current.status).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const response = await orgApi.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
      ...as,
      ifMatch: revision,
      body: { effectiveDate: '2026-09-01', personInChargeId: personId },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function managerOf(recordId: string) {
    return (await w.business(recordId)).fields.directManagerId;
  }

  async function linkageEvents(businessId: string) {
    return (await w.outboxEvents(businessId)).filter((event) => event.eventType.startsWith('transfer.linkage'));
  }

  return {
    hire,
    contract,
    contracts,
    contractChanges,
    transfer,
    saved,
    linkage,
    retryItem,
    orgPeople,
    setHead,
    managerOf,
    linkageEvents,
  };
}

/** 受控权限替身：授权、各对象范围与可见字段分别可控（未限制的对象返回其登记的全部字段）。 */
export interface ControlledGrants {
  readonly deny?: (request: Parameters<Authorizer>[0]) => boolean;
  readonly scopes?: Readonly<Record<string, ModuleScope>>;
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  /** 按用户覆盖可见字段（审批自动跳过时按被跳过的审批人判定，第四轮）。 */
  readonly userFields?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export function everyField(objectCode: string): string[] {
  const definition = Object.values(MODULE_OBJECTS).find((object) => object.code === objectCode);
  return definition ? definition.fields.map((field) => field.code) : [];
}

export function controlledApi(db: Db, tenantId: string, userId: string, grants: ControlledGrants, at: string) {
  const authorize: Authorizer = (request) => !grants.deny?.(request);
  const all: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
  registerScopeProvider(authorize, {
    scope: async (query) => grants.scopes?.[query.objectCode ?? ''] ?? all,
    authorize: async (request) => authorize(request),
    fields: async (_tenant, user, objectCode) =>
      new Set(grants.userFields?.[user]?.[objectCode] ?? grants.fields?.[objectCode] ?? everyField(objectCode)),
  });
  const api = tenantApi(db, { authorize, clock: () => new Date(at) });
  return (method: string, path: string, options: { body?: object; ifMatch?: number; key?: string } = {}) =>
    api.request(method, path, {
      user: userId,
      tenant: tenantId,
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.body ? { body: options.body } : {}),
      ...(options.key ? { idempotencyKey: options.key } : {}),
    });
}
