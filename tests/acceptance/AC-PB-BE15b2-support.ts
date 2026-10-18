/**
 * BE-15b2 自动发起考核验收夹具（docs/02_业务建模/29 PB-R16 / R17 / R20 / R21）：在 BE-15b1 的考核世界上（部门、直线经理、
 * 部门负责人、考核两类与转正预置流程已发布）加自动考核规则、总开关、立即执行与每日批次的辅助。
 * 世界的“今天”是 2026-10-01（APV_TODAY），试用员工 2026-09-01 入职，即入职后第 30 天。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { assessmentWorld, type AssessmentWorld } from './AC-PB-BE15b1-support.js';

const EMPLOYMENT = '/api/tenant/employment';
export const AUTO_ASSESSMENT_SWITCH = 'probation.auto_assessment_enabled';
export const AUTO_REGULARIZATION_SWITCH = 'probation.auto_regularization_enabled';
export const SCHEDULER = '../../apps/api/src/modules/employment/auto-assessment-scheduler.js';
export const rowsOf = <T>(r: unknown) => (Array.isArray(r) ? r : (r as { rows: T[] }).rows) as T[];

export interface AutoAssessmentRule {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly orgIds: string[];
  readonly includeSubordinates: boolean;
  readonly assessmentType: 'probation' | 'regularization';
  readonly daysAfterEntry: number;
  readonly initiatorType: string;
  readonly enabled: boolean;
  readonly revision: number;
}

export interface AutoAssessmentReceipt {
  readonly businessDate: string;
  readonly launched: { employeeId: string; ruleId: string; assessmentId: string; assessmentStatus: string }[];
  readonly failed: { employeeId: string; ruleId: string; reason: string }[];
  readonly nextCursor?: string | null;
}

export interface AutoAssessmentScheduler {
  runAutoAssessments(
    db: Db,
    meta: { actorUserId: null; commandId: string },
    input?: { tenantId?: string },
    options?: { clock?: () => Date },
  ): Promise<{
    runs: (AutoAssessmentReceipt & { tenantId: string; ran: boolean; skippedLocked: number; errors: unknown[] })[];
  }>;
}

export async function autoAssessmentWorld(db: Db, label: string) {
  const w = await assessmentWorld(db, `auto-${label}`);
  const hr = (method: string, path: string, options: Parameters<AssessmentWorld['request']>[3] = {}) =>
    w.request(w.hr.id, method, `${EMPLOYMENT}${path}`, options);
  const body = (extra: Record<string, unknown> = {}) => ({
    name: '入职满 30 天试用中考核',
    priority: 1,
    orgIds: [w.department],
    includeSubordinates: true,
    assessmentType: 'probation',
    daysAfterEntry: 30,
    initiatorType: 'rule_operator',
    ...extra,
  });
  const create = (value: unknown, ifMatch = 0) => hr('POST', '/auto-assessment-rules', { ifMatch, body: value });
  async function created(value: unknown): Promise<AutoAssessmentRule> {
    const response = await create(value);
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as AutoAssessmentRule;
  }
  async function list(): Promise<AutoAssessmentRule[]> {
    const response = await hr('GET', '/auto-assessment-rules');
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { items: AutoAssessmentRule[] }).items;
  }
  async function setEnabled(id: string, revision: number, enabled: boolean) {
    const response = await hr('PUT', `/auto-assessment-rules/${id}/enabled`, { ifMatch: revision, body: { enabled } });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as AutoAssessmentRule;
  }
  async function enableSwitch(key = AUTO_ASSESSMENT_SWITCH, value = true) {
    const path = `/api/tenant/settings/${key}`;
    const current = await w.json<{ revision: number }>(await w.request(w.hr.id, 'GET', path));
    const put = await w.request(w.hr.id, 'PUT', path, { ifMatch: current.revision, body: { value } });
    expect(put.status, await put.clone().text()).toBe(200);
  }
  const runNow = (key?: string, body: unknown = {}) =>
    hr('POST', '/auto-assessment/run', { ifMatch: 0, body, idempotencyKey: key });
  async function ran(key?: string): Promise<AutoAssessmentReceipt> {
    const response = await runNow(key);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as AutoAssessmentReceipt;
  }
  async function scheduler(): Promise<AutoAssessmentScheduler> {
    const module = (await import(SCHEDULER).catch(() => null)) as AutoAssessmentScheduler | null;
    expect(module, '缺少自动考核调度入口').not.toBeNull();
    return module!;
  }
  /** 每日批次：租户本地（Asia/Shanghai）日期 + 04:00 之后的第一次调度。 */
  async function batch(clock: string, commandId: string = randomUUID()) {
    const { runAutoAssessments } = await scheduler();
    const result = await runAutoAssessments(
      w.db,
      { actorUserId: null, commandId },
      { tenantId: w.tenant.id },
      { clock: () => new Date(clock) },
    );
    expect(result.runs).toHaveLength(1);
    return result.runs[0]!;
  }
  const asTenant = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(w.db, w.tenant.id, fn);
  async function assessmentsOf(employeeId: string) {
    return asTenant(async (tx) =>
      rowsOf<{
        id: string;
        assessment_type: string;
        assessment_name: string;
        assessment_date: string;
        status: string;
        initiation: string;
        system_proxy: boolean;
        initiator_user_id: string;
        anchor_id: string;
      }>(
        await tx.execute(sql`SELECT id::text, assessment_type, assessment_name, assessment_date::text, status,
            initiation, system_proxy, initiator_user_id::text, anchor_id::text
          FROM employment_probation_assessments WHERE tenant_id=${w.tenant.id} AND employee_id=${employeeId}::uuid
          ORDER BY created_at, id`),
      ),
    );
  }
  async function launchesOf(employeeId: string) {
    return asTenant(async (tx) =>
      rowsOf<{
        rule_id: string;
        state: string;
        assessment_id: string | null;
        system_proxy: boolean;
        attempts: number;
        last_reason: string | null;
        initiator_user_id: string | null;
      }>(
        await tx.execute(sql`SELECT rule_id::text, state, assessment_id::text, system_proxy, attempts, last_reason,
            initiator_user_id::text
          FROM employment_auto_assessment_launches WHERE tenant_id=${w.tenant.id} AND employee_id=${employeeId}::uuid
          ORDER BY created_at, rule_id`),
      ),
    );
  }
  /** 本任职周期的开启记录（入职业务）：考核 / 台账的 anchor_id。 */
  async function anchorOf(employeeId: string) {
    const [row] = await asTenant(async (tx) =>
      rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id::text FROM employment_records WHERE tenant_id=${w.tenant.id}
          AND employee_id=${employeeId}::uuid AND kind='hire' ORDER BY created_at DESC LIMIT 1`),
      ),
    );
    return row!.id;
  }
  /** 直接写一条考核记录（夹具：造 PB-R21 的各种状态 × 意见组合，不走审批）。 */
  async function seedAssessment(
    employeeId: string,
    row: { type: 'probation' | 'regularization'; status: string; opinion?: string | null },
  ) {
    const id = randomUUID();
    const anchorId = await anchorOf(employeeId);
    await asTenant((tx) =>
      tx.execute(sql`INSERT INTO employment_probation_assessments(id, tenant_id, employee_id, anchor_id,
          department_id, assessment_type, assessment_name, assessment_date, regularization_opinion, regularization_date,
          status, initiation, initiator_user_id, revision, command_id)
        VALUES (${id}::uuid, ${w.tenant.id}, ${employeeId}::uuid, ${anchorId}::uuid, ${w.department}::uuid,
          ${row.type}, '夹具考核', '2026-09-20'::date, ${row.opinion ?? null}, NULL, ${row.status}, 'manual',
          ${w.hr.id}::uuid, 1, ${randomUUID()})`),
    );
    return id;
  }
  return {
    ...w,
    hr,
    body,
    create,
    created,
    list,
    setEnabled,
    enableSwitch,
    runNow,
    ran,
    scheduler,
    batch,
    asTenant,
    assessmentsOf,
    launchesOf,
    anchorOf,
    seedAssessment,
  };
}
export type AutoAssessmentWorld = Awaited<ReturnType<typeof autoAssessmentWorld>>;
