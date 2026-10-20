/**
 * BE-6b 结束实习验收夹具：在 BE-6a 的实习生夹具上加结束实习入口、在途实习转正（审批中 / 审批通过未生效）、
 * 晚批、审批实例 / 待办 / 站内消息 / 审计 / 台账读取，以及按指定时钟运行的定时生效调度。
 * 全部走 HTTP 路由与平台调度入口，不直接写任职表。
 */
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations, type Authorizer, type EmploymentActivationRun } from '@italent/api';
import { sql, withTenant } from '@italent/db';
import { expect } from 'vitest';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { internWorld, type InternWorld } from './AC-IN-BE6a-support.js';
import { runContractJobs } from '../../apps/api/src/modules/contracts/scheduler.js';
import { allowAll, cmd, tenantApi } from './support/tenant-api.js';

export async function endWorld(db: InternWorld['db'], label: string) {
  const w = await internWorld(db, label);
  const tenantId = w.session.tenant.id;
  const rows = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => {
      const result = await tx.execute(statement);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as T[];
    });

  /** 结束实习：返回原始响应（失败用例要读状态码与错误码）。 */
  const terminate = async (employeeId: string, body: Record<string, unknown>, ifMatch?: number) =>
    w.session.request('POST', `/interns/${employeeId}/terminate`, {
      ifMatch: ifMatch ?? (await w.revision(employeeId)),
      body,
    });

  /** 结束实习且必须成功，返回离职业务（含落地的任职记录）。 */
  async function terminateOk(employeeId: string, body: Record<string, unknown>) {
    const response = await terminate(employeeId, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as {
      id: string;
      status: string;
      mode: string;
      kind: string;
      record?: { kind: string; changeType: string | null; effectiveDate: string; employeeStatus: number } & {
        fields: Record<string, unknown>;
      };
    };
  }

  const statusOf = async (businessId: string) =>
    ((await (await w.session.request('GET', `/businesses/${businessId}`)).json()) as { status: string }).status;

  const timeline = (employeeId: string) =>
    rows<{ kind: string; start_date: string; valid: string }>(sql`
      SELECT r.kind, t.start_date::text, t.valid_during::text AS valid
      FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId}::uuid ORDER BY t.start_date, t.sort_order`);
  const exitRow = async (businessId: string) =>
    (
      await rows<{
        mode: string;
        initiator: string;
        reason_code: string | null;
        exit_type_code: string | null;
        whereabouts_code: string | null;
        handover_employee_id: string | null;
      }>(sql`SELECT mode, initiator, reason_code, exit_type_code, whereabouts_code, handover_employee_id
        FROM exit_requests WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`)
    )[0];
  const audits = (businessId: string, action: string) =>
    rows<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(sql`
      SELECT before, after FROM audit_events WHERE tenant_id=${tenantId} AND object_id=${businessId}
        AND action=${action} ORDER BY occurred_at, id`);
  const outboxCount = async (businessId: string, eventType: string) =>
    Number(
      (
        await rows<{ n: number }>(sql`SELECT count(*) AS n FROM employment_outbox WHERE tenant_id=${tenantId}
          AND business_id=${businessId}::uuid AND event_type=${eventType}`)
      )[0]!.n,
    );
  const instanceOf = async (businessId: string) =>
    (
      await rows<{ id: string; status: string }>(sql`SELECT id, status FROM approval_instances
        WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY created_at DESC LIMIT 1`)
    )[0];
  const pendingTasks = (instanceId: string) =>
    rows<{ id: string }>(sql`SELECT id FROM approval_tasks WHERE tenant_id=${tenantId}
      AND instance_id=${instanceId}::uuid AND status='pending'`);
  const notices = (instanceId: string) =>
    rows<{ recipient: string; template: string }>(sql`
      SELECT recipient_user_id AS recipient, template_code AS template FROM approval_notifications
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid AND kind='message' ORDER BY recipient_user_id`);
  const attempts = (businessId: string) =>
    rows<{ outcome: string; reason: string | null }>(sql`SELECT outcome, reason FROM employment_activation_attempts
      WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY attempt_no`);
  const leaves = async (employeeId: string) =>
    Number(
      (
        await rows<{ n: number }>(sql`SELECT count(*) AS n FROM employment_records WHERE tenant_id=${tenantId}
          AND employee_id=${employeeId}::uuid AND kind='leave'`)
      )[0]!.n,
    );

  /** 审批中心最后节点在 at 通过（可信端口，时钟由参数给定）；返回通过后的业务状态。 */
  async function approveAt(businessId: string, at: string) {
    const current = (await (await w.session.request('GET', `/businesses/${businessId}`)).json()) as {
      revision: number;
    };
    await runEmploymentTransition(
      db,
      {
        tenantId,
        userId: w.session.user.id,
        timezone: w.session.tenant.timezone,
        now: new Date(at),
        commandId: randomUUID(),
        expectedRevision: current.revision,
      },
      { id: businessId, action: 'approve' },
    );
    return statusOf(businessId);
  }

  /** 定时任务：平台入口，按注入的 UTC 时钟运行。 */
  async function runScheduler(at: string) {
    const result = await runEmploymentActivations(db, cmd(), { tenantId }, { clock: () => new Date(at) });
    expect(result.runs).toHaveLength(1);
    return result.runs[0] as EmploymentActivationRun;
  }

  /** 批量造该员工名下的合成实习转正申请（一条语句；复制首个载荷版本的必填列，没有审批实例）。 */
  const bulkRegularizations = (employeeId: string, count: number, state = 'in_review') =>
    rows(sql`
      WITH ids AS (
        SELECT gen_random_uuid() AS bid, gen_random_uuid() AS vid FROM generate_series(1, ${count}::int)
      ), base AS (
        SELECT tenant_id, employee_id, form_id, employ_type FROM employment_payload_versions
        WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY created_at, version_no LIMIT 1
      ), objects AS (
        INSERT INTO employment_business_objects(id,tenant_id,employee_id)
        SELECT bid, ${tenantId}, ${employeeId}::uuid FROM ids RETURNING id
      ), versions AS (
        INSERT INTO employment_payload_versions(id,tenant_id,employee_id,business_id,version_no,command_id,kind,mode,
          effective_date,form_id,employ_type,created_at)
        SELECT vid, base.tenant_id, base.employee_id, bid, 1, NULL, 'intern_regularization', 'application',
          '2026-12-01'::date, base.form_id, base.employ_type, '2026-10-01T01:00:00Z'::timestamptz FROM ids, base
        RETURNING id
      )
      INSERT INTO employment_state_events(tenant_id,employee_id,business_id,payload_version_id,state,event_no,
        command_id)
      SELECT ${tenantId}, ${employeeId}::uuid, bid, vid, ${state}, 1, 'bulk-regularization' FROM ids`);
  const stateCounts = (employeeId: string) =>
    rows<{ state: string; n: number }>(sql`
      SELECT s.state, count(*)::int AS n FROM employment_business_objects b
      JOIN LATERAL (SELECT state FROM employment_state_events e WHERE e.tenant_id=b.tenant_id AND e.business_id=b.id
        ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE b.tenant_id=${tenantId} AND b.employee_id=${employeeId}::uuid GROUP BY s.state ORDER BY s.state`);

  /** 合同模块（HR 会话）：建一份带终止日期的实习协议，并按给定日期跑合同到期任务（开启到期自动终止）。 */
  const contractApi = tenantApi(db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const contracts = (method: string, path: string, init: { body?: object; ifMatch?: number } = {}) =>
    contractApi.request(method, `/api/tenant/contracts${path}`, {
      ...init,
      user: w.session.user.id,
      tenant: tenantId,
    });
  async function internAgreement(employeeId: string, endDate: string) {
    const master = async (kind: string, name: string) => {
      const response = await contracts('POST', `/master-data/${kind}`, {
        ifMatch: 0,
        body: { code: randomUUID(), name },
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return (await response.json()) as { id: string };
    };
    const type = await master('types', '实习协议');
    const company = await master('companies', '合成法人公司');
    const settings = (await (await contracts('GET', '/settings')).json()) as { revision: number };
    expect(
      (await contracts('PUT', '/settings', { ifMatch: settings.revision, body: { autoTerminate: true } })).status,
    ).toBe(200);
    const created = await contracts('POST', '/commands', {
      ifMatch: 0,
      body: {
        operation: 'create',
        mode: 'direct',
        employeeId,
        fields: {
          typeId: type.id,
          companyId: company.id,
          effectiveDate: '2026-09-01',
          endDate,
          termType: 'fixed',
          termMonths: 2,
          signingDate: '2026-08-25',
        },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    return (await created.json()) as { id: string };
  }
  const contractStatus = async (contractId: string) =>
    (
      await rows<{ status: string; end_date: string }>(sql`SELECT status, end_date::text FROM contract_records
        WHERE tenant_id=${tenantId} AND id=${contractId}::uuid`)
    )[0];
  const sweepContracts = (at: string) =>
    runContractJobs(db, { tenantId }, { clock: () => new Date(at), authorize: allowAll });

  return {
    ...w,
    tenantId,
    rows,
    bulkRegularizations,
    stateCounts,
    internAgreement,
    contractStatus,
    sweepContracts,
    terminate,
    terminateOk,
    statusOf,
    timeline,
    exitRow,
    audits,
    outboxCount,
    instanceOf,
    pendingTasks,
    notices,
    leaves,
    attempts,
    approveAt,
    runScheduler,
  };
}
export type EndWorld = Awaited<ReturnType<typeof endWorld>>;

/** 指定授权器与数据范围（缺省看全部）的请求函数；字段权限放开到结束实习要写的任职字段。 */
export function restrictedRequest(w: InternWorld, authorize: Authorizer, orgIds: readonly string[] = []) {
  const all = orgIds.length === 0;
  const terms = orgIds.length ? [{ dimension: 'organization' as const, orgIds, personIds: [] }] : [];
  registerScopeProvider(authorize, {
    scope: async () => ({ ...EMPTY_SCOPE, orgIds, all, hasDataPermission: true, terms }),
    authorize: async (request) => authorize(request),
    fields: async () =>
      new Set(['id', 'employeeId', 'kind', 'mode', 'effectiveDate', 'status', 'revision', 'lastWorkDate']),
  });
  const api = tenantApi(w.db, { authorize, clock: () => new Date('2026-10-01T01:00:00.000Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };
  return (method: string, path: string, options: { body?: object; ifMatch?: number } = {}) =>
    api.request(method, `/api/tenant/employment${path}`, { ...as, ...options });
}

/** 部门 w.org 的内部员工严格控编 1 人（占编的内部员工须先入职）；转正为内部员工会超编。 */
export async function strictCapacity(w: InternWorld) {
  const api = tenantApi(w.db, { clock: () => new Date('2026-10-01T01:00:00Z') });
  const as = { user: w.session.user.id, tenant: w.session.tenant.id, ifMatch: 0 };
  const post = (path: string, body: object) => api.request('POST', `/api/tenant/establishment${path}`, { ...as, body });
  const base = {
    periodType: 'annual',
    maintenanceMode: 'local',
    startDate: '2026-01-01',
    occupancyRanges: [{ employmentType: 'internal' }],
  };
  const scheme = await post('/schemes', { name: '合成结束实习控编方案', ...base });
  expect(scheme.status, await scheme.clone().text()).toBe(201);
  const { id: schemeId } = (await scheme.json()) as { id: string };
  const capacity = { orgId: w.org.id, schemeId, periodStart: '2026-01-01', localCapacity: 1, strictControl: true };
  expect((await post('/capacities', capacity)).status).toBe(201);
}
