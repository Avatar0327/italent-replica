/**
 * R2-T03 B2a 验收夹具：门禁 / 申请服务 / 关口测试共用。
 * 在 activationWorld（带审批兜底流程、调出 / 调入部门、已入职员工）之上加：受限授权的 HTTP 入口、
 * 离职相关读取（扩展行、状态快照）、造数（审批中的转正等合成申请、已落地的联动未完成调动）。
 * “前后读取逐项相等”统一用 stateOf：时间轴、业务头与版本 / 事件计数、扩展行、合同、审批实例 / 任务、
 * 任职 outbox 与生效尝试的计数，再加 F-196 补的四类：exit_effects、业务审计、审批日志、成功命令台账。
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

/**
 * 前后读取比较用的状态快照（设计 §18.1 / B-80 / B-86：逐项相等），按租户 + 员工（或其业务 / 审批实例）过滤，
 * 全部有稳定排序；时间戳等易变列不进快照。F-196 补的四类（#362 第 1 轮 P3-5）：
 * effects = exit_effects；audits = 业务审计（audit_events 的动作 / 对象 / 前后值）；
 * approvalLogs = 审批实例动作日志；ledger = 成功（< 400）命令台账，按命令键，只取响应落在本员工的业务 / 员工 / 审批实例上的条目。
 */
export async function stateSnapshot(db: Db, tenantId: string, employeeId: string) {
  const t = tenantId;
  const e = employeeId;
  const rows = <T = Record<string, unknown>>(statement: ReturnType<typeof sql>) =>
    withTenant(db, t, async (tx) => rowsOf<T>(await tx.execute(statement)));
  const ownBusinesses = sql`SELECT id::text FROM employment_business_objects WHERE tenant_id=${t}
    AND employee_id=${e}::uuid`;
  return {
    timeline: await rows(sql`SELECT record_id, start_date::text, sort_order FROM employment_timeline
      WHERE tenant_id=${t} AND employee_id=${e}::uuid ORDER BY start_date, sort_order`),
    businesses: await rows(sql`SELECT b.id, b.revision,
        (SELECT count(*) FROM employment_payload_versions p
          WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id) AS versions,
        (SELECT count(*) FROM employment_state_events s
          WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id) AS events,
        (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
          ORDER BY event_no DESC LIMIT 1) AS state
      FROM employment_business_objects b WHERE b.tenant_id=${t} AND b.employee_id=${e}::uuid ORDER BY b.id`),
    exits: await rows(sql`SELECT * FROM exit_requests WHERE tenant_id=${t} AND employee_id=${e}::uuid
      ORDER BY business_id`),
    contracts: await rows(sql`SELECT id, status, end_date::text, deleted FROM contract_records
      WHERE tenant_id=${t} AND employee_id=${e}::uuid ORDER BY id`),
    instances: await rows(sql`SELECT i.id, i.status, i.revision,
        (SELECT string_agg(k.status, ',' ORDER BY k.id) FROM approval_tasks k
          WHERE k.tenant_id=i.tenant_id AND k.instance_id=i.id) AS tasks
      FROM approval_instances i WHERE i.tenant_id=${t} AND i.subject_employee_id=${e}::uuid ORDER BY i.id`),
    outbox: await rows(sql`SELECT count(*) AS n FROM employment_outbox WHERE tenant_id=${t}
      AND employee_id=${e}::uuid`),
    attempts: await rows(sql`SELECT count(*) AS n FROM employment_activation_attempts WHERE tenant_id=${t}
      AND employee_id=${e}::uuid`),
    effects: await rows(sql`SELECT business_id, phase, kind, target_type, target_id, detail, command_id
      FROM exit_effects WHERE tenant_id=${t} AND employee_id=${e}::uuid
      ORDER BY business_id, phase, kind, target_type, target_id, command_id, id`),
    audits: await rows<{
      action: string;
    }>(sql`SELECT action, object_type, object_id, operation, actor_user_id, before, after, command_id
      FROM audit_events WHERE tenant_id=${t}
        AND (scope_employee_id=${e}::uuid OR object_id=${e}::text OR object_id IN (${ownBusinesses}))
      ORDER BY action, object_type, object_id, command_id, occurred_at, id`),
    approvalLogs: await rows(sql`SELECT l.instance_id, l.seq, l.round, l.node_key, l.task_id, l.event,
        l.actor_user_id, l.detail
      FROM approval_instance_logs l JOIN approval_instances i ON i.tenant_id=l.tenant_id AND i.id=l.instance_id
      WHERE l.tenant_id=${t} AND i.subject_employee_id=${e}::uuid ORDER BY l.instance_id, l.seq`),
    ledger: await rows(sql`SELECT command_id, command_type, response_status, actor_user_id, request_hash,
        md5(response_body::text) AS body_hash
      FROM command_ledger WHERE tenant_id=${t} AND response_status < 400
        AND (response_body->>'id' = ${e}::text OR response_body->>'employeeId' = ${e}::text
          OR response_body->>'id' IN (${ownBusinesses}) OR response_body->>'businessId' IN (${ownBusinesses})
          OR response_body->>'id' IN (SELECT id::text FROM approval_instances
            WHERE tenant_id=${t} AND subject_employee_id=${e}::uuid))
      ORDER BY command_id`),
  };
}

/** after 比 before 多出的行（快照里的行是纯 JSON，按序列化值比较）。 */
export function addedRows<T>(before: readonly T[], after: readonly T[]): T[] {
  const seen = new Set(before.map((row) => JSON.stringify(row)));
  return after.filter((row) => !seen.has(JSON.stringify(row)));
}

export type StateSnapshot = Awaited<ReturnType<typeof stateSnapshot>>;

/** 部分对象应变化的用例：除 changed 列出的键外逐项相等（取代手挑几项比较），changed 的键由调用方逐项另行断言。 */
export function expectOnlyChanged(before: StateSnapshot, after: StateSnapshot, changed: (keyof StateSnapshot)[]) {
  const keep = (state: StateSnapshot) =>
    Object.fromEntries(Object.entries(state).filter(([key]) => !changed.includes(key as keyof StateSnapshot)));
  expect(keep(after)).toEqual(keep(before));
}

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
  const stateOf = (employeeId: string) => stateSnapshot(db, w.session.tenant.id, employeeId);

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
