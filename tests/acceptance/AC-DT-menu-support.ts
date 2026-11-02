/**
 * R2-T09a 职责转交菜单验收夹具（DEC-602② / DEC-726 / F-408，规格 `30` “菜单立即转交实测”“菜单指定日期转交实测”）。
 * 在离职下游夹具（downstreamWorld：下属、同事、离职生效、定时任务）之上加菜单接口 /api/tenant/duty-transfers 与组织版本读取。
 * 菜单接口只经 HTTP 调用；转交记录只经记录查询接口读取，不直接读新表。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import type { Authorizer } from '@italent/api';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE, type ModuleScope } from '../../apps/api/src/modules/permission/scope-types.js';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { everyField } from './AC-LNK-support.js';
import { retireBody } from './AC-RT-support.js';
import { pinExitGate, tenantApi } from './support/tenant-api.js';

export const MENU_OBJECT = 'TenantBase.DutyTransferCommon';
export const MENU_TODAY = '2026-10-06';

export interface DutyView {
  readonly key: string;
  readonly dutyType: 1 | 2;
  readonly orgId: string | null;
  readonly orgRole: string | null;
  readonly subordinateId: string | null;
  readonly relation: string | null;
  readonly description: string;
  readonly pending: {
    readonly recordId: string;
    readonly revision: number;
    readonly receiverId: string;
    readonly transferDate: string;
  } | null;
}

export interface DutiesView {
  readonly employeeId: string;
  readonly total: number;
  readonly pendingCount: number;
  readonly hint: string | null;
  readonly items: DutyView[];
}

export interface RecordView {
  readonly id: string;
  readonly employeeId: string;
  readonly receiverId: string | null;
  readonly dutyType: number;
  readonly dutyDetails: string;
  readonly status: 0 | 1 | 2 | 3;
  readonly transferDate: string | null;
  readonly transferTime: string | null;
  readonly batchId: string | null;
  readonly source: 1 | 2 | 3 | 4;
  readonly operatorId: string | null;
  readonly failure: { readonly code: string; readonly message: string; readonly rule: string | null } | null;
}

export interface SubmitItem {
  readonly dutyType: 1 | 2;
  readonly orgId?: string;
  readonly orgRole?: string;
  readonly subordinateId?: string;
  readonly relation?: string;
  readonly receiverId: string | null;
  readonly revision?: number;
}

export interface SubmitBody {
  readonly timing: 'immediate' | 'scheduled';
  readonly transferDate?: string;
  readonly items: readonly SubmitItem[];
}

const BASE = '/api/tenant/duty-transfers';

export async function menuWorld(db: Db, label: string, today = MENU_TODAY) {
  const x = await downstreamWorld(db, label, today);
  const tenantId = x.session.tenant.id;
  const user = x.session.user.id;
  let nowIso = `${today}T02:00:00Z`;
  const api = tenantApi(db, { clock: () => new Date(nowIso) });
  const request = (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
    api.request(method, `${BASE}${path}`, { user, tenant: tenantId, ...init });

  /** 组织负责人经组织接口设置（2026-09-01 起）。 */
  async function setHead(orgId: string, personId: string) {
    const as = { user, tenant: tenantId };
    const current = await api.request('GET', `/api/tenant/org/organizations/${orgId}`, as);
    expect(current.status).toBe(200);
    const { revision } = (await current.json()) as { revision: number };
    const response = await api.request('PATCH', `/api/tenant/org/organizations/${orgId}`, {
      ...as,
      ifMatch: revision,
      body: { effectiveDate: '2026-09-01', personInChargeId: personId },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }

  /** 组织版本链（启用日 + 负责人），按版本号排列。 */
  const orgVersions = (orgId: string) =>
    withTenant(db, tenantId, async (tx) =>
      x.rowsOf<{ start: string; head: string | null }>(
        await tx.execute(sql`SELECT start_date::text AS start, person_in_charge_id::text AS head FROM org_versions
          WHERE tenant_id=${tenantId} AND org_id=${orgId}::uuid ORDER BY version_no`),
      ),
    );
  /** at 日生效的负责人。 */
  const headAt = async (orgId: string, at: string) =>
    (await orgVersions(orgId)).filter((version) => version.start <= at).at(-1)?.head ?? null;

  async function duties(employeeId: string): Promise<DutiesView> {
    const response = await request('GET', `/people/${employeeId}/duties`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as DutiesView;
  }

  const submit = (employeeId: string, body: SubmitBody, key?: string) =>
    request('POST', `/people/${employeeId}`, { ifMatch: 0, body, ...(key ? { idempotencyKey: key } : {}) });

  async function submitted(employeeId: string, body: SubmitBody) {
    const response = await submit(employeeId, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { batchId: string; count: number; records: RecordView[] };
  }

  async function check(employeeId: string, body: SubmitBody) {
    const response = await request('POST', `/people/${employeeId}/check`, { body });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as {
      count: number;
      receivers: { receiverId: string; name: string; count: number }[];
      message: string;
      warnings: { receiverId: string; reason: string }[];
    };
  }

  async function records(query = 'tab=all') {
    const response = await request('GET', `/records?${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { total: number; items: RecordView[] };
  }

  async function departed(query = '', send = request) {
    const response = await send('GET', `/departed${query ? `?${query}` : ''}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as {
      total: number;
      items: { employeeId: string; kind: 'leave' | 'retirement'; date: string; dutyCount: number }[];
    };
  }

  /** 已生效的退休（与 effectiveExit 同口径：临时切回可信造数端口办直接退休）。 */
  async function effectiveRetire(employeeId: string, lastWorkDate: string) {
    const previous = pinExitGate('seed');
    try {
      const created = await x.createdLeave(employeeId, retireBody(lastWorkDate, 'direct'));
      expect(created.status).toBe('effective');
      return created;
    } finally {
      pinExitGate(previous);
    }
  }

  /** 员工时间轴逐段：开始日、业务类型、异动类型（change_type）。 */
  const segments = (employeeId: string) =>
    x.sqlRows<{ start: string; kind: string; changeType: string | null }>(sql`
      SELECT t.start_date::text AS start, r.kind, r.change_type AS "changeType"
      FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId}::uuid ORDER BY t.start_date, t.sort_order`);

  /** 转交记录的执行台账（次数 / 失败原因不在记录接口的字段里）。 */
  const ledger = async (recordId: string) =>
    (
      await x.sqlRows<{ attempts: number; failure: string | null; status: number }>(sql`
        SELECT attempt_count AS attempts, failure_code AS failure, status
        FROM duty_transfer_records WHERE tenant_id=${tenantId} AND id=${recordId}::uuid`)
    ).at(0);

  async function reason(response: Response) {
    const body = (await response.json()) as { error?: { code: string; details?: { reason?: string } } };
    return { status: response.status, code: body.error?.code, reason: body.error?.details?.reason };
  }

  /** 只看得到 personIds 这些人的转交记录 / 菜单（DT-R9）；其余对象看全部。hidden：本对象看不到的字段。 */
  function scopedRequest(personIds: readonly string[], hidden: readonly string[] = []) {
    const authorize: Authorizer = () => true;
    const all: ModuleScope = { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
    const limited: ModuleScope = {
      ...EMPTY_SCOPE,
      hasDataPermission: true,
      personIds,
      terms: [{ dimension: 'management', orgIds: [], personIds }],
    };
    registerScopeProvider(authorize, {
      scope: async (query) => (query.objectCode === MENU_OBJECT ? limited : all),
      authorize: async () => true,
      fields: async (_tenant, _user, objectCode) =>
        new Set(everyField(objectCode).filter((field) => objectCode !== MENU_OBJECT || !hidden.includes(field))),
    });
    const scoped = tenantApi(db, { authorize, clock: () => new Date(nowIso) });
    return (method: string, path: string, init: Parameters<typeof scoped.request>[2] = {}) =>
      scoped.request(method, `${BASE}${path}`, { user, tenant: tenantId, ...init });
  }

  return {
    ...x,
    request,
    setHead,
    orgVersions,
    headAt,
    duties,
    submit,
    submitted,
    check,
    records,
    departed,
    effectiveRetire,
    segments,
    ledger,
    reason,
    scopedRequest,
    setNow(iso: string) {
      nowIso = iso;
      x.setNow(iso);
    },
  };
}

export type MenuWorld = Awaited<ReturnType<typeof menuWorld>>;

/** 组织角色条目（负责人）。 */
export const headItem = (orgId: string, receiverId: string | null, revision?: number): SubmitItem => ({
  dutyType: 1,
  orgId,
  orgRole: 'person_in_charge',
  receiverId,
  ...(revision === undefined ? {} : { revision }),
});

/** 下属条目（直线）。 */
export const subordinateItem = (subordinateId: string, receiverId: string | null, revision?: number): SubmitItem => ({
  dutyType: 2,
  subordinateId,
  relation: 'direct',
  receiverId,
  ...(revision === undefined ? {} : { revision }),
});
