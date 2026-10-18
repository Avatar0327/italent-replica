/**
 * F-229 验收夹具：离职与在途考核同在一个租户。
 * 在考核夹具（assessmentWorld：审批中心 + 考核两类预置流程 + 试用员工）之上加离职种子、兜底审批流程（离职申请要匹配流程）、
 * 离职的真实创建入口（走 §4A 门禁）与内部编排器入口 activateExit；离职其余关口仍闭（B3-3 之前），所以生效只能经编排器。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { exitActivator } from './AC-EXIT-activation-support.js';
import { leaveBody } from './AC-EXIT-gate-support.js';
import { installExitSeeds } from './AC-EXIT-support.js';
import { installApprovalFallbacks } from './AC-APV-support.js';
import { assessmentWorld } from './AC-PB-BE15b1-support.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';

const EMPLOYMENT = '/api/tenant/employment';
/** 夹具时钟停在 2026-10-01；最后工作日 10-02 → 计划生效日 10-03。 */
export const LAST_WORK_DATE = '2026-10-02';
export const EFFECTIVE_DAY = '2026-10-03';

export async function assessmentExitWorld(db: Db, label: string) {
  const a = await assessmentWorld(db, `f229-${label}`);
  const tenantId = a.tenant.id;
  await installExitSeeds(db, tenantId);
  // 离职申请提交要匹配已发布流程（DEC-017）：只给离职装兜底，考核两类用预置流程
  await installApprovalFallbacks(db, tenantId, a.hr.id, ['leave']);
  const activate = exitActivator(db, { tenant: a.tenant, user: a.hr });
  const rows = <T>(statement: ReturnType<typeof sql>) =>
    withTenant(db, tenantId, async (tx) => rowsOf<T>(await tx.execute(statement)));

  const leaveCall = async (employeeId: string, body: object, actor = a.hr.id) =>
    a.request(actor, 'POST', `${EMPLOYMENT}/employees/${employeeId}/businesses`, {
      ifMatch: await a.employeeRevision(employeeId),
      body,
    });
  async function reasonOf(response: Response) {
    const body = (await response.json()) as { error?: { code: string; details?: Record<string, unknown> } };
    return { status: response.status, code: body.error?.code, ...(body.error?.details ?? {}) } as {
      status: number;
      code?: string;
      reason?: string;
      ackToken?: string;
      assessments?: { items: { assessmentId: string; message?: string }[]; hiddenCount: number };
    };
  }
  async function createdLeave(employeeId: string, mode: 'application' | 'direct', exit?: object) {
    const response = await leaveCall(employeeId, leaveBody(LAST_WORK_DATE, mode, exit));
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; status: string };
  }
  const previewCall = (employeeId: string, lastWorkDate = LAST_WORK_DATE, actor = a.hr.id) =>
    a.request(actor, 'POST', `${EMPLOYMENT}/exits/employees/${employeeId}/preview`, { body: { lastWorkDate } });
  const submitCall = (leave: { id: string; revision: number }, body: object = {}) =>
    a.request(a.hr.id, 'POST', `${EMPLOYMENT}/exits/${leave.id}/submit`, { ifMatch: leave.revision, body });

  /** 离职申请经审批中心办结（兜底流程首节点落到异常管理员），只停在 approved（关口②）。 */
  async function approvedApplication(employeeId: string) {
    const draft = await createdLeave(employeeId, 'application', { exitTypeCode: 'voluntary' });
    const submitted = await submitCall(draft);
    expect(submitted.status, await submitted.clone().text()).toBe(200);
    const view = await a.instanceOf(draft.id);
    const task = a.pending(view)[0]!;
    const done = await a.taskAction(task.assigneeUserId, task.id, 'approve', view.revision, {});
    expect(done.status, await done.clone().text()).toBe(200);
    return draft;
  }

  const assessmentRow = async (id: string) =>
    (
      await rows<{ status: string; revision: number }>(sql`SELECT status, revision::int AS revision
        FROM employment_probation_assessments WHERE tenant_id=${tenantId} AND id=${id}::uuid`)
    )[0]!;
  const instanceRows = (businessId: string) =>
    rows<{ id: string; status: string }>(sql`SELECT id, status FROM approval_instances
      WHERE tenant_id=${tenantId} AND business_type='probation_assessment' AND business_id=${businessId}::uuid
      ORDER BY created_at`);
  const pendingTaskCount = async (businessId: string) =>
    Number(
      (
        await rows<{ n: number }>(sql`SELECT count(*)::int AS n FROM approval_tasks t
          JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
          WHERE t.tenant_id=${tenantId} AND i.business_id=${businessId}::uuid AND t.status='pending'`)
      )[0]!.n,
    );
  const audits = (assessmentId: string, action: string) =>
    rows<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor: string | null }>(sql`
      SELECT before, after, actor_user_id AS actor FROM audit_events WHERE tenant_id=${tenantId}
        AND object_id=${assessmentId} AND action=${action}`);
  /** 离职单状态（approved / effective …）。 */
  const leaveStatus = async (leaveId: string) =>
    (
      await a.json<{ status: string }>(await a.request(a.hr.id, 'GET', `${EMPLOYMENT}/businesses/${leaveId}`))
    ).status;

  return {
    ...a,
    tenantId,
    timezone: a.tenant.timezone,
    activate,
    rows,
    leaveCall,
    reasonOf,
    createdLeave,
    previewCall,
    submitCall,
    approvedApplication,
    assessmentRow,
    instanceRows,
    pendingTaskCount,
    audits,
    leaveStatus,
  };
}

export type AssessmentExitWorld = Awaited<ReturnType<typeof assessmentExitWorld>>;
