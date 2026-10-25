/**
 * R2 BE-5c2 预计退休日期 / 弹性范围的逐员工计算与写入（R2-T04 §9.2 “写入”“候选”）。每日批次与立即执行共用本文件，
 * 匹配与取值一律经 5c1 的 resolveExpectedDate / resolveFlexibleRange（DEC-641，不另写一套年龄 / 日期计算），
 * 写入一律经人事写端口 appendEmployee（同一 normalizeRetirementRange，A-20，手工与批处理同一函数）：
 * - 预计退休日期已核准 = 是：不写 P（AC-RT-02）；算出值与当前值相同不写；无命中 / 算不出 → 清空（A-4）；
 * - 弹性范围已核准 = 是：不写上下限，但 P 为空时按 A-20 清空；
 * - 只算计算日当天在职者（时间轴当天记录不是 leave / retirement、人员状态不是待入职）；离职 / 退休人员不重算（A-4）。
 * 调用方已持员工锁（每日批次 SKIP LOCKED、立即执行整页预锁）。
 */
import { sql, type Tx } from '@italent/db';
import {
  EMPLOYEE_STATUS,
  PERSONNEL_OBJECT,
  resolveExpectedDate,
  resolveFlexibleRange,
  RETIREMENT_AUTO_EXPECTED_DATE_KEY,
  RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY,
  tenantLocalDate,
  type RetirementPerson,
  type RetirementRule,
  type RetirementRulePurpose,
} from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { SYSTEM_USER_ID, auditActor } from '../../system-actor.js';
import { appendEmployee } from '../personnel/employee-write.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { EmploymentError } from './errors.js';
import { findCurrentRecord } from './read-model.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const RETIREMENT_RULE_REASON = 'retirement_rule';

const SWITCH_KEYS: Readonly<Record<RetirementRulePurpose, string>> = {
  expected_date: RETIREMENT_AUTO_EXPECTED_DATE_KEY,
  flexible_range: RETIREMENT_AUTO_FLEXIBLE_RANGE_KEY,
};

/** 对应的自动计算开关（两层配置；系统值 false，A-5）。 */
export async function readRetirementSwitch(tx: Tx, tenantId: string, purpose: RetirementRulePurpose) {
  return (await readEffectiveSetting(tx, tenantId, SWITCH_KEYS[purpose])).value === true;
}

/** 系统写入的上下文：审计 actor 为空（系统），不带请求方的授权器与数据范围（规则按适用组织办理，不叠加操作人范围）。 */
export function systemContext(ctx: EmploymentContext): EmploymentContext {
  return {
    tenantId: ctx.tenantId,
    userId: SYSTEM_USER_ID,
    timezone: ctx.timezone,
    now: ctx.now,
    commandId: ctx.commandId,
    expectedRevision: 0,
  };
}

/** 计算日当天在职的员工（员工 ID 升序分页，cursor 之后）；是否命中规则、是否变化在员工锁内逐人判定。 */
export async function retirementCandidates(
  tx: Tx,
  tenantId: string,
  today: string,
  cursor: string | null,
  limit: number,
): Promise<string[]> {
  const inactive = [EMPLOYEE_STATUS.pendingEntry, EMPLOYEE_STATUS.retired, EMPLOYEE_STATUS.left];
  const rows = rowsOf<{ employeeId: string }>(
    await tx.execute(sql`SELECT DISTINCT cr.employee_id::text AS "employeeId" FROM employment_timeline cur
      JOIN employment_records cr ON cr.tenant_id=cur.tenant_id AND cr.id=cur.record_id
      LEFT JOIN LATERAL employment_record_status(cr.tenant_id, cr.id) st ON true
      WHERE cur.tenant_id=${tenantId} AND cur.valid_during @> ${today}::date
        AND cr.kind NOT IN ('leave', 'retirement') AND st.employee_status NOT IN (${sql.join(
          inactive.map((status) => sql`${status}`),
          sql`, `,
        )})
        AND (${cursor}::uuid IS NULL OR cr.employee_id>${cursor}::uuid)
      ORDER BY 1 LIMIT ${limit}`),
  );
  return rows.map((row) => row.employeeId);
}

interface PersonRow {
  readonly birthday: string | null;
  readonly gender: string | null;
  readonly nationality: string | null;
  readonly identityType: string | null;
  readonly expected: string | null;
  readonly confirmed: boolean | null;
  readonly earliest: string | null;
  readonly latest: string | null;
  readonly flexConfirmed: boolean | null;
}

/** 人事最新版本（员工锁内读）；日期一律按文本取，不经驱动的 Date 转换。 */
async function personOf(tx: Tx, tenantId: string, employeeId: string): Promise<PersonRow | null> {
  const [row] = rowsOf<PersonRow>(
    await tx.execute(sql`SELECT birthday::text AS birthday, gender, nationality, identity_type AS "identityType",
        expected_retirement_date::text AS expected, expected_retirement_confirmed AS confirmed,
        earliest_retirement_date::text AS earliest, latest_retirement_date::text AS latest,
        flexible_range_confirmed AS "flexConfirmed"
      FROM personnel_employee_versions WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid
      ORDER BY revision DESC LIMIT 1`),
  );
  return row ?? null;
}

/** 计算日当天的在职主职记录；不是候选（离职 / 退休 / 待入职 / 无记录）返回 null。 */
async function activeRecord(tx: Tx, tenantId: string, employeeId: string, today: string) {
  const current = await findCurrentRecord(tx, tenantId, employeeId, today);
  if (!current || current.kind === 'leave' || current.kind === 'retirement') return null;
  const [status] = rowsOf<{ status: number }>(
    await tx.execute(sql`SELECT employee_status::integer AS status
      FROM employment_record_status(${tenantId}, ${current.id}::uuid)`),
  );
  const inactive: readonly number[] = [EMPLOYEE_STATUS.pendingEntry, EMPLOYEE_STATUS.retired, EMPLOYEE_STATUS.left];
  return !status || inactive.includes(status.status) ? null : current;
}

interface Planned {
  readonly ruleId: string | null;
  readonly patch: Record<string, string | null>;
}

const same = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);

function planExpected(rules: readonly RetirementRule[], person: RetirementPerson, row: PersonRow): Planned | null {
  if (row.confirmed === true) return null;
  const hit = resolveExpectedDate(rules, person, { birthday: row.birthday, expectedDate: row.expected });
  const next = hit?.date ?? null;
  return same(next, row.expected) ? null : { ruleId: hit?.rule.id ?? null, patch: { expectedRetirementDate: next } };
}

function planFlexible(rules: readonly RetirementRule[], person: RetirementPerson, row: PersonRow): Planned | null {
  const cleared = { earliestRetirementDate: null, latestRetirementDate: null };
  if (row.flexConfirmed === true)
    // 核准冻结上下限；P 为空时清空优先（A-20，核准标志本身不动）
    return !row.expected && (row.earliest || row.latest) ? { ruleId: null, patch: cleared } : null;
  const hit = resolveFlexibleRange(rules, person, { birthday: row.birthday, expectedDate: row.expected });
  const next = { earliestRetirementDate: hit?.earliest ?? null, latestRetirementDate: hit?.latest ?? null };
  if (same(next.earliestRetirementDate, row.earliest) && same(next.latestRetirementDate, row.latest)) return null;
  return { ruleId: hit?.rule.id ?? null, patch: next };
}

export interface RetirementUpdated {
  readonly employeeId: string;
  readonly ruleId: string | null;
  readonly fields: string[];
}
export interface RetirementFailed {
  readonly employeeId: string;
  readonly reason: string;
}
export type RetirementOutcome =
  ({ readonly kind: 'updated' } & RetirementUpdated) | ({ readonly kind: 'failed' } & RetirementFailed) | null;

/** 一名员工（调用方已持员工锁）。不是候选 / 无变化返回 null；业务拒绝记为 failed（保存点回滚该员工的写入）。 */
export async function applyRetirementRules(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  purpose: RetirementRulePurpose,
  rules: readonly RetirementRule[],
  triggeredBy?: string,
): Promise<RetirementOutcome> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  try {
    return await tx.transaction(async (savepoint) => {
      const current = await activeRecord(savepoint, ctx.tenantId, employeeId, today);
      const row = current && (await personOf(savepoint, ctx.tenantId, employeeId));
      if (!current || !row) return null;
      const person: RetirementPerson = {
        orgId: current.fields.departmentId ?? null,
        gender: row.gender,
        nationality: row.nationality,
        employType: current.fields.employType ?? null,
        identityType: row.identityType,
      };
      const plan = (purpose === 'expected_date' ? planExpected : planFlexible)(rules, person, row);
      if (!plan) return null;
      await appendEmployee(savepoint, ctx, employeeId, plan.patch, false);
      const fields = Object.keys(plan.patch);
      await recordAudit(savepoint, {
        tenantId: ctx.tenantId,
        actorUserId: auditActor(ctx.userId),
        action: 'personnel.retirement_rule',
        objectType: PERSONNEL_OBJECT,
        objectId: employeeId,
        before: null,
        after: {
          reason: RETIREMENT_RULE_REASON,
          purpose,
          ruleId: plan.ruleId,
          fields,
          ...(triggeredBy ? { triggeredBy } : {}),
        },
        commandId: ctx.commandId,
        occurredAt: ctx.now,
        scope: { employeeId },
      });
      return { kind: 'updated' as const, employeeId, ruleId: plan.ruleId, fields };
    });
  } catch (error) {
    if (!(error instanceof AppError || error instanceof EmploymentError)) throw error;
    const details = (error as { details?: unknown }).details;
    const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
    return { kind: 'failed', employeeId, reason: typeof reason === 'string' ? reason : error.code };
  }
}

/** 把逐人结果收进回执。 */
export function collectRetirementOutcome(
  run: { updated: RetirementUpdated[]; failed: RetirementFailed[] },
  outcome: RetirementOutcome,
): void {
  if (!outcome) return;
  const { kind, ...item } = outcome;
  if (kind === 'updated') run.updated.push(item as RetirementUpdated);
  else run.failed.push(item as RetirementFailed);
}
