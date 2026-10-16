/**
 * R2-T03 B2a 验收夹具：门禁 / 申请服务 / 关口测试共用。
 * 在 activationWorld（带审批兜底流程、调出 / 调入部门、已入职员工）之上加：受限授权的 HTTP 入口、
 * 离职相关读取（扩展行、状态快照）、造数（审批中的转正等合成申请、已落地的联动未完成调动）。
 * “前后读取逐项相等”统一用 stateOf：时间轴、业务头与版本 / 事件计数、扩展行、合同、审批实例 / 任务、
 * 任职 outbox 与生效尝试的计数。
 */
import { randomUUID } from 'node:crypto';
import type { Authorizer } from '@italent/api';
import { createUser, grantMembership, sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { registerScopeProvider } from '../../apps/api/src/modules/permission/module-access.js';
import { EMPTY_SCOPE } from '../../apps/api/src/modules/permission/scope-types.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import { activationWorld, type ActivationWorld } from './AC-TRF-activation-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const BASE = '/api/tenant/employment';

export const leaveBody = (lastWorkDate: string, mode: 'application' | 'direct' = 'application', exit?: object) => ({
  kind: 'leave',
  mode,
  lastWorkDate,
  fields: {},
  ...(exit ? { exit } : {}),
});

/** 拒绝指定按钮的授权器（其余放行）。按钮资源形如 `对象#按钮@层级`。 */
export const denyButtons =
  (...codes: string[]): Authorizer =>
  (request) =>
    !(request.action === 'object.button' && codes.some((code) => String(request.resource).includes(`#${code}@`)));

export async function gateWorld(db: Db, label: string, options: { today?: string } = {}) {
  const today = options.today ?? '2026-10-06';
  const w = await activationWorld(db, label, { today });
  await installExitSeeds(db, w.session.tenant.id);
  let nowIso = `${today}T01:00:00.000Z`;
  const as = { user: w.session.user.id, tenant: w.session.tenant.id };

  /** 受限 HR：authorize 自定义；scopeCreator 给出时数据范围只含“该用户创建的对象”（使用用户维度）。 */
  function restricted(authorize: Authorizer, scopeCreator?: string) {
    const scope = scopeCreator
      ? {
          ...EMPTY_SCOPE,
          hasDataPermission: true,
          terms: [{ dimension: 'using_user' as const, orgIds: [], personIds: [], creatorId: scopeCreator }],
        }
      : { ...EMPTY_SCOPE, all: true, hasDataPermission: true };
    registerScopeProvider(authorize, {
      scope: async () => scope,
      authorize: async (request) => authorize(request),
      fields: async () => new Set(['id', 'employeeId', 'kind', 'effectiveDate', 'status', 'revision', 'lastWorkDate']),
    });
    const api = tenantApi(db, { authorize, clock: () => new Date(nowIso) });
    return (method: string, path: string, init: Parameters<typeof api.request>[2] = {}) =>
      api.request(method, `${BASE}${path}`, { ...as, ...init });
  }

  const setNow = (iso: string) => {
    nowIso = iso;
    w.session.setNow(iso);
  };

  async function createLeave(
    employeeId: string,
    body: object,
    request: (m: string, p: string, i?: object) => Promise<Response> = w.session.request,
  ) {
    const employee = await w.session.getEmployee(employeeId);
    return request('POST', `/employees/${employeeId}/businesses`, { ifMatch: employee.revision, body });
  }

  async function createdLeave(employeeId: string, body: object) {
    const response = await createLeave(employeeId, body);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string };
  }

  async function reason(response: Response) {
    const body = (await response.json()) as { error?: { code: string; details?: Record<string, unknown> } };
    return { status: response.status, code: body.error?.code, ...(body.error?.details ?? {}) } as {
      status: number;
      code?: string;
      reason?: string;
      ackToken?: string;
      items?: { businessId: string; effectiveDate: string }[];
      hiddenCount?: number;
    };
  }

  /** 以另一用户的身份发起并提交调动申请（创建者与主用户不同）。 */
  async function applyAs(userId: string, employeeId: string, effectiveDate: string, fields: object) {
    const api = tenantApi(db, { clock: () => new Date(nowIso) });
    const identity = { user: userId, tenant: w.session.tenant.id };
    const employee = await w.session.getEmployee(employeeId);
    const body = { kind: 'transfer', mode: 'application', effectiveDate, fields };
    const draft = await api.request('POST', `${BASE}/employees/${employeeId}/businesses`, {
      ...identity,
      ifMatch: employee.revision,
      body,
    });
    expect(draft.status, await draft.clone().text()).toBe(201);
    const created = (await draft.json()) as { id: string; revision: number };
    const submitted = await api.request('POST', `${BASE}/businesses/${created.id}/submit`, {
      ...identity,
      ifMatch: created.revision,
      body: {},
    });
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    return (await submitted.json()) as { id: string; revision: number };
  }

  /** 以另一用户的身份建员工（创建者与主用户不同）。 */
  async function employeeAs(userId: string, name: string) {
    const api = tenantApi(db, { clock: () => new Date(nowIso) });
    const response = await api.request('POST', `${BASE}/employees`, {
      user: userId,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body: { name, code: `EMP_${randomUUID().replaceAll('-', '')}` },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }

  const sqlRows = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, w.session.tenant.id, async (tx) => rowsOf<T>(await tx.execute(statement)));

  const exitRow = async (businessId: string) =>
    (
      await sqlRows<Record<string, unknown>>(sql`SELECT * FROM exit_requests WHERE tenant_id=${w.session.tenant.id}
      AND business_id=${businessId}::uuid`)
    )[0];

  /** 前后读取比较用的状态快照（设计 §18.1 / B-80 / B-86：逐项相等）。 */
  async function stateOf(employeeId: string) {
    const t = w.session.tenant.id;
    const e = employeeId;
    return {
      timeline: await sqlRows(sql`SELECT record_id, start_date::text, sort_order FROM employment_timeline
        WHERE tenant_id=${t} AND employee_id=${e}::uuid ORDER BY start_date, sort_order`),
      businesses: await sqlRows(sql`SELECT b.id, b.revision,
          (SELECT count(*) FROM employment_payload_versions p
            WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id) AS versions,
          (SELECT count(*) FROM employment_state_events s
            WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id) AS events,
          (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
            ORDER BY event_no DESC LIMIT 1) AS state
        FROM employment_business_objects b WHERE b.tenant_id=${t} AND b.employee_id=${e}::uuid ORDER BY b.id`),
      exits: await sqlRows(sql`SELECT * FROM exit_requests WHERE tenant_id=${t} AND employee_id=${e}::uuid
        ORDER BY business_id`),
      contracts: await sqlRows(sql`SELECT id, status, end_date::text, deleted FROM contract_records
        WHERE tenant_id=${t} AND employee_id=${e}::uuid ORDER BY id`),
      instances: await sqlRows(sql`SELECT i.id, i.status, i.revision,
          (SELECT string_agg(k.status, ',' ORDER BY k.id) FROM approval_tasks k
            WHERE k.tenant_id=i.tenant_id AND k.instance_id=i.id) AS tasks
        FROM approval_instances i WHERE i.tenant_id=${t} AND i.subject_employee_id=${e}::uuid ORDER BY i.id`),
      outbox: await sqlRows(sql`SELECT count(*) AS n FROM employment_outbox WHERE tenant_id=${t}
        AND employee_id=${e}::uuid`),
      attempts: await sqlRows(sql`SELECT count(*) AS n FROM employment_activation_attempts WHERE tenant_id=${t}
        AND employee_id=${e}::uuid`),
    };
  }

  /** 同租户的第二个用户（HTTP 入口以其身份发起写入，创建者与主用户不同）。 */
  async function otherUser() {
    const user = await createUser(db, { email: `other-${randomUUID()}@example.com`, displayName: '另一用户' }, cmd());
    await grantMembership(db, { tenantId: w.session.tenant.id, userId: user.id, expectedRevision: 0 }, cmd());
    return user;
  }

  /**
   * 合成申请 / 业务：直接在库里造任意 kind、任意最新状态的单（载荷版本与状态事件），不经业务入口。
   * 复制员工首个载荷版本的必填列；linked = true 造“已落地、联动未完成”的调动（effective + 联动待办事件 + 部门负责人标志）。
   */
  async function synthetic(
    employeeId: string,
    input: { kind: string; state: string; effectiveDate: string; linked?: boolean; reminderOnly?: boolean },
  ) {
    const businessId = randomUUID();
    const versionId = randomUUID();
    const t = w.session.tenant.id;
    await withTenant(db, t, async (tx) => {
      await tx.execute(sql`INSERT INTO employment_business_objects(id,tenant_id,employee_id)
        VALUES (${businessId}::uuid,${t},${employeeId}::uuid)`);
      await tx.execute(sql`INSERT INTO employment_payload_versions
          (id,tenant_id,employee_id,business_id,version_no,command_id,kind,mode,effective_date,form_id,employ_type,
           created_at,is_department_head)
        SELECT ${versionId}::uuid,tenant_id,employee_id,${businessId}::uuid,1,NULL,${input.kind},'application',
          ${input.effectiveDate}::date,form_id,employ_type,'2026-10-01T01:00:00Z'::timestamptz,
          ${input.linked && !input.reminderOnly ? true : null}
        FROM employment_payload_versions WHERE tenant_id=${t} AND employee_id=${employeeId}::uuid
          AND business_id<>${businessId}::uuid ORDER BY created_at, version_no LIMIT 1`);
      const states = input.state === 'approved' ? ['in_review', 'approved'] : [input.state];
      for (const [index, state] of states.entries())
        await tx.execute(sql`INSERT INTO employment_state_events
            (tenant_id,employee_id,business_id,payload_version_id,state,event_no,command_id,event_seq)
          VALUES (${t},${employeeId}::uuid,${businessId}::uuid,${versionId}::uuid,${state},${index + 1},
            ${`synthetic-${index}`},${1000 + index})`);
      if (input.linked)
        await tx.execute(sql`INSERT INTO employment_outbox(tenant_id,employee_id,business_id,event_type,object_type,
            object_id,command_id,payload,created_at)
          VALUES (${t},${employeeId}::uuid,${businessId}::uuid,'employment.transfer.linkage.pending',
            'employment-business',${businessId}::uuid,'synthetic','{}'::jsonb,'2026-10-01T01:00:00Z'::timestamptz)`);
    });
    return businessId;
  }

  return {
    ...w,
    as,
    setNow,
    restricted,
    createLeave,
    createdLeave,
    reason,
    exitRow,
    stateOf,
    otherUser,
    applyAs,
    employeeAs,
    synthetic,
    sqlRows,
  };
}

export type GateWorld = Awaited<ReturnType<typeof gateWorld>>;
export type { ActivationWorld };
