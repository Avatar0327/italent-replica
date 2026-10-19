/**
 * R2 BE-8b1 验收夹具：离职生效写黑名单（DM-R2 / DM-R3，AC-DM-06 端到端）。
 * 在 downstreamWorld（B3-3 开闸后的离职夹具）之上加：总开关与规则的公开接口、黑名单读取、再入职保存探测。
 * 一律经公开入口造数；读业务表只用于核对“名单行记下的离职请求 ID”这类不对外披露的列。
 */
import { sql, type Db } from '@italent/db';
import { expect } from 'vitest';
import { downstreamWorld, type DownstreamWorld } from './AC-EXIT-downstream-support.js';
import { addHire, hireBody } from './AC-EN-BE2a-support.js';
import { blacklistApi, type BlacklistEntry } from './AC-DM-R2-blacklist-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { uniqueSuffix } from './support/unique.js';

export const TODAY = '2026-10-06';
/** 最后工作日 10-05 → 计划生效日 10-06 = 今天：保存即生效。 */
export const DUE_LAST_WORK_DATE = '2026-10-05';
/** 最后工作日 10-10 → 计划生效日 10-11：保存后停在 approved，等调度 / 编排器落地。 */
export const FUTURE_LAST_WORK_DATE = '2026-10-10';
export const FUTURE_EFFECTIVE_DATE = '2026-10-11';

export interface BlacklistRow {
  readonly id: string;
  readonly employeeId: string | null;
  readonly reason: string;
  readonly blacklistDate: string;
  readonly expiryDate: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly status: string;
  readonly exitRequestId: string | null;
}

export async function blacklistExitWorld(db: Db, label: string) {
  const x = await downstreamWorld(db, `bl-exit-${label}`, TODAY);
  const tenantId = x.session.tenant.id;
  const page = blacklistApi(x.session);
  const as = { tenant: tenantId, user: x.session.user.id };

  async function setAutoSwitch(value: boolean) {
    const current = await x.api.request('GET', '/api/tenant/settings/exit.auto_blacklist_enabled', as);
    const revision = ((await current.json()) as { revision: number }).revision;
    const response = await x.api.request('PUT', '/api/tenant/settings/exit.auto_blacklist_enabled', {
      ...as,
      ifMatch: revision,
      body: { value },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  async function addRule(orgIds: string[], extra: Record<string, unknown> = {}) {
    const response = await x.session.request('POST', '/blacklist-rules', {
      ifMatch: 0,
      body: {
        name: `规则-${uniqueSuffix()}`,
        priority: 1,
        orgIds,
        conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }],
        term: 'permanent',
        reason: 'instability',
        ...extra,
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }

  /** 直接读业务表（含不对外披露的 exit_request_id），按加黑日期与 ID 排序。 */
  const rows = (employeeId: string) =>
    x.sqlRows<BlacklistRow>(sql`SELECT id, employee_id AS "employeeId", reason, blacklist_date::text AS "blacklistDate",
      expiry_date::text AS "expiryDate", note, source, status, exit_request_id::text AS "exitRequestId"
      FROM employment_blacklist WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
      ORDER BY blacklist_date, id`);
  const activeRows = async (employeeId: string) => (await rows(employeeId)).filter((row) => row.status === 'active');

  const exitColumns = (businessId: string) =>
    x.sqlRows<{ add: boolean; reason: string | null; expiry: string | null; note: string | null }>(sql`
      SELECT add_to_blacklist AS add, blacklist_reason AS reason, blacklist_expiry_date::text AS expiry,
        blacklist_note AS note FROM exit_requests WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`);

  /** 公开新建入口（HR 端专用路径 POST exits/employees/:id）。 */
  async function createExit(employeeId: string, lastWorkDate: string, mode: 'application' | 'direct', exit: object) {
    const employee = await x.session.getEmployee(employeeId);
    return x.session.request('POST', `/exits/employees/${employeeId}`, {
      ifMatch: employee.revision,
      body: { mode, lastWorkDate, fields: {}, exit },
    });
  }
  async function createdExit(employeeId: string, lastWorkDate: string, mode: 'application' | 'direct', exit: object) {
    const response = await createExit(employeeId, lastWorkDate, mode, exit);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string };
  }

  /** 再入职保存（DEC-569：保存时拦截）；返回原始响应。 */
  async function rehire(employeeId: string, effectiveDate = '2026-10-20') {
    const employee = await x.session.getEmployee(employeeId);
    return addHire(x.session, employee, { ...hireBody(x.from.id, effectiveDate), kind: 'rehire' });
  }

  /** 在 from 部门入职的另一名在职员工（直线经理缺省）。 */
  const colleague = (name: string) => x.peer(name);

  const reasonOf = async (response: Response) => {
    const body = (await response.json()) as {
      error?: { code: string; message: string; details?: { reason?: string } };
    };
    return { status: response.status, code: body.error?.code, message: body.error?.message, ...body.error?.details };
  };

  const auditActions = (objectId: string, action: string) =>
    x.sqlRows<{ after: Record<string, unknown> | null }>(sql`SELECT after FROM audit_events
      WHERE tenant_id=${tenantId} AND object_id=${objectId} AND action=${action} ORDER BY occurred_at, id`);

  return {
    ...x,
    tenantId,
    page,
    as,
    setAutoSwitch,
    addRule,
    rows,
    activeRows,
    exitColumns,
    createExit,
    createdExit,
    rehire,
    colleague,
    reasonOf,
    auditActions,
    leaveBody,
  };
}

export type BlacklistExitWorld = Awaited<ReturnType<typeof blacklistExitWorld>>;
export type { BlacklistEntry, DownstreamWorld };
