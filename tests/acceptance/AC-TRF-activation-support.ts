/**
 * R1-T08 定时生效验收夹具：员工在调出部门入职，经可信审批端口（R1-T07 审批中心最后节点同事务调用的同一端口）
 * 推进调动申请；定时任务经平台入口 runEmploymentActivations 运行，时钟由测试注入（DEC-056）。
 */
import { randomUUID } from 'node:crypto';
import { runEmploymentActivations, type EmploymentActivationRun } from '@italent/api';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { employmentSession, type EmploymentBusiness, type EmploymentSession } from './AC-EMP-support.js';
import { cmd } from './support/tenant-api.js';

export interface ActivationView {
  readonly status: 'pending' | 'failed' | 'suspended' | 'effective';
  readonly failureCount: number;
  readonly failureReason: string | null;
  readonly blockedByBusinessId: string | null;
  readonly lastAttemptAt: string | null;
}

export type ActivationBusiness = EmploymentBusiness & { readonly activation: ActivationView | null };

/** 生效失败待办：业务单标识 + 生效结果（与业务详情的 activation 同形）。 */
export interface ActivationTodo {
  readonly id: string;
  readonly employeeId: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly activation: ActivationView;
}

export async function activationWorld(
  db: Db,
  label: string,
  options: { timezone?: string; today?: string; hireDate?: string } = {},
) {
  const session = await employmentSession(db, label, { timezone: options.timezone });
  session.setNow(`${options.today ?? '2026-10-01'}T01:00:00.000Z`);
  // R1-T07：提交申请须匹配已发布流程（DEC-017）；本组验收只验证生效阶段，安装兜底流程。
  await installApprovalFallbacks(db, session.tenant.id, session.user.id);
  const from = await session.org('调出部门', { startDate: '2026-01-01' });
  const to = await session.org('调入部门', { startDate: '2026-01-01' });
  return { db, session, from, to, ...helpers(db, session, options.hireDate ?? '2026-09-01', from.id) };
}

export type ActivationWorld = Awaited<ReturnType<typeof activationWorld>>;

function helpers(db: Db, session: EmploymentSession, hireDate: string, departmentId: string) {
  async function hired(name = '定时生效员工') {
    const employee = await session.employee(name);
    const hire = await session.business(
      employee.id,
      { kind: 'hire', mode: 'direct', effectiveDate: hireDate, fields: { departmentId, place: '原地点' } },
      employee.revision,
    );
    expect(hire.status).toBe('effective');
    return { employee, hire };
  }

  async function business(id: string): Promise<ActivationBusiness> {
    const response = await session.request('GET', `/businesses/${id}`);
    expect(response.status).toBe(200);
    return (await response.json()) as ActivationBusiness;
  }

  /** 发起并提交调动申请（只存申请单，DEC-125）。 */
  async function apply(employeeId: string, effectiveDate: string, fields: Record<string, unknown>) {
    const employee = await session.getEmployee(employeeId);
    const draft = await session.business(
      employeeId,
      { kind: 'transfer', mode: 'application', effectiveDate, fields },
      employee.revision,
    );
    const response = await session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ActivationBusiness;
  }

  /** 审批中心最后节点通过时调用的可信端口（transitions.approve）。 */
  async function approve(target: { id: string }, at: string): Promise<ActivationBusiness> {
    const service = await import('../../apps/api/src/modules/employment/transitions.js');
    const current = await business(target.id);
    const result = await service.runEmploymentTransition(
      db,
      {
        tenantId: session.tenant.id,
        userId: session.user.id,
        timezone: session.tenant.timezone,
        now: new Date(at),
        commandId: randomUUID(),
        expectedRevision: current.revision,
      },
      { id: target.id, action: 'approve' },
    );
    expect(result.status).toBe(200);
    return result.body as ActivationBusiness;
  }

  /** 定时任务：平台入口，按服务器 UTC 时钟运行（DEC-056）。 */
  async function runScheduler(at: string, input: { limit?: number; cursor?: string } = {}) {
    const result = await runEmploymentActivations(
      db,
      cmd(),
      { tenantId: session.tenant.id, ...input },
      { clock: () => new Date(at) },
    );
    expect(result.runs).toHaveLength(1);
    return result.runs[0] as EmploymentActivationRun;
  }

  async function retry(target: { id: string }, at: string, idempotencyKey?: string) {
    session.setNow(at);
    const current = await business(target.id);
    return session.request('POST', `/businesses/${target.id}/activation/retry`, {
      ifMatch: current.revision,
      body: {},
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async function todos(): Promise<ActivationTodo[]> {
    const response = await session.request('GET', '/activation-todos');
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: ActivationTodo[] }).items;
  }

  /** 生效相关的审计事件（事件时间存 UTC）。 */
  async function auditEvents(businessId: string) {
    return withTenant(db, session.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT action, actor_user_id AS "actorUserId",
          occurred_at AS "occurredAt", after FROM audit_events
        WHERE tenant_id=${session.tenant.id} AND object_id=${businessId} ORDER BY occurred_at, id`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        action: string;
        actorUserId: string | null;
        occurredAt: Date | string;
        after: Record<string, unknown> | null;
      }[];
    });
  }

  async function outboxEvents(businessId: string) {
    return withTenant(db, session.tenant.id, async (tx) => {
      const result = await tx.execute(sql`SELECT event_type AS "eventType", state FROM employment_outbox
        WHERE tenant_id=${session.tenant.id} AND business_id=${businessId}::uuid ORDER BY created_at, id`);
      return (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
        eventType: string;
        state: string;
      }[];
    });
  }

  return { hired, business, apply, approve, runScheduler, retry, todos, auditEvents, outboxEvents };
}
