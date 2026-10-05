import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { requireScopedEmploymentObject, requireEmploymentWrite } from './context.js';
import { AppError } from '../../errors.js';
import { getCustomFieldsForInheritance } from './configuration.js';
import { currentEmploymentCycle } from './cycles.js';
import { loadEmploymentRecord } from './read-model.js';
import { camelRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from './record-store.js';
import {
  matchingForwardChanges,
  applyForwardChanges,
  skipsWholeRecord,
  wholeRecordSkipReminder,
  type ForwardValues,
  type ForwardFieldChange,
} from './forward-rules.js';
import { availableForwardChanges, referenceCheckDate } from './forward-references.js';
import { appendForwardPayload, auditForwardTarget } from './forward-store.js';
import { operationKey } from './timeline.js';
import type { EmploymentContext, EmploymentState } from './types.js';

export interface ForwardSource {
  readonly employeeId: string;
  readonly businessId?: string;
  readonly staffId: string;
  readonly effectiveDate: string;
  readonly evaluationDate?: string;
  readonly before: ForwardValues;
  readonly after: ForwardValues;
}
interface ForwardTarget {
  readonly payload: EmploymentPayloadRow;
  readonly status: EmploymentState;
  readonly values: ForwardValues;
}
export interface ForwardChange {
  readonly businessId: string;
  readonly staffId: string;
  readonly status: EmploymentState;
  readonly fields: readonly ForwardFieldChange[];
}
/** DEC-120：因规则②整条跳过的后续记录；fields 为本可按值匹配同步的字段，提醒 HR 核对、需要时手工处理。 */
export interface WholeRecordSkip extends ForwardChange {
  readonly effectiveDate: string;
  readonly reason: 'DEPARTMENT_POSITION_MISMATCH';
}
export interface ForwardPlan {
  readonly changes: ForwardChange[];
  readonly skipped: { readonly businessId?: string; readonly reason: string; readonly fields?: string[] }[];
  readonly wholeRecordSkips: WholeRecordSkip[];
}
const TARGET_LIMIT = 1000;

async function requireLinkedScope(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string | null,
  businessId: string,
): Promise<void> {
  try {
    await requireScopedEmploymentObject(tx, ctx, employeeId, departmentId, businessId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      // TODO(需取证 Q-M0-33): 原站联动越权提示及引导文案待取证。
      throw new AppError('LINKED_RECORD_OUT_OF_SCOPE', '联动记录不在当前数据范围，请由覆盖该范围的人员操作');
    }
    throw error;
  }
}

async function linkedScopeAllows(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  departmentId: string | null,
  businessId: string,
): Promise<boolean> {
  try {
    await requireScopedEmploymentObject(tx, ctx, employeeId, departmentId, businessId);
    return true;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

/** 已落地的源记录（生效、编辑）按其时间轴位置比较；尚未落地（预览新增）视为生效日当天最后一条。 */
async function sourceOrder(tx: Tx, ctx: EmploymentContext, source: ForwardSource): Promise<number | null> {
  if (!source.businessId) return null;
  const [point] = rowsOf<{ sortOrder: number }>(
    await tx.execute(sql`
    SELECT sort_order AS "sortOrder" FROM employment_timeline
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${source.employeeId}::uuid
      AND record_id=${source.businessId}::uuid AND start_date=${source.effectiveDate}::date
  `),
  );
  return point?.sortOrder ?? null;
}

/**
 * 候选查询只访问已锁定员工的周期；超预算整体拒绝，绝不静默截断。
 * 后续记录按“生效日 + 同日操作先后”排序（DEC-108、AC-FWD-13）：生效记录取时间轴上排在源记录之后的，同日在后的
 * 也算；未生效的申请取生效日不早于源日期的（07 A2），同日排在生效记录之后、按发起先后。
 * TODO(需取证 #44)：编辑同日在前的记录时，原站是否也更新同日在后的生效记录未实测（新增业务总在当日最后，不受影响）。
 */
/**
 * 同日未落地的申请只接受操作先后排在来源之后的向后更新（PR #53 第三轮清单第 3 项，暂定口径）：较早提交的申请
 * 落地时插在来源之前（DEC-108），不应被之后的直接业务改写。来源尚未写状态事件（正在保存的直接业务、预览）时视为
 * 最新一次操作，同日申请一律不更新。
 * TODO(需取证 Q-M0-61)：原站同日较早提交的申请是否接受之后业务的向后更新。
 */
function sameDayPendingAfterSource(ctx: EmploymentContext, source: ForwardSource): SQL {
  const sourceKey = source.businessId ? operationKey(ctx.tenantId, sql`${source.businessId}::uuid`) : sql`NULL`;
  return sql`${operationKey(ctx.tenantId, sql`b.id`)} > ${sourceKey}`;
}

async function candidates(tx: Tx, ctx: EmploymentContext, source: ForwardSource): Promise<ForwardTarget[]> {
  const order = await sourceOrder(tx, ctx, source);
  const laterEffective =
    order === null
      ? sql`t.start_date>${source.effectiveDate}::date`
      : sql`(t.start_date,t.sort_order)>(${source.effectiveDate}::date,${order})`;
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
    SELECT p.*,s.state FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.employee_id=b.employee_id AND p.business_id=b.id
      ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.employee_id=b.employee_id AND s.business_id=b.id
      ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.employee_id=b.employee_id AND r.id=b.id
    LEFT JOIN employment_timeline t ON t.tenant_id=r.tenant_id AND t.employee_id=r.employee_id AND t.record_id=r.id
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${source.employeeId}::uuid
      ${source.businessId ? sql`AND b.id<>${source.businessId}::uuid` : sql``}
      AND (r.staff_id=${source.staffId}::uuid OR (r.id IS NULL AND p.selected_staff_id=${source.staffId}::uuid))
      AND ((s.state='effective' AND ${laterEffective})
        OR (s.state IN ('draft','in_review','approved','rejected')
          AND (p.effective_date>${source.effectiveDate}::date
            OR (p.effective_date=${source.effectiveDate}::date AND ${sameDayPendingAfterSource(ctx, source)}))))
    ORDER BY p.effective_date,t.sort_order NULLS LAST,b.created_at,b.id LIMIT ${TARGET_LIMIT + 1}
  `),
  );
  if (rows.length > TARGET_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '向后更新目标超过单次处理上限');
  const result: ForwardTarget[] = [];
  for (const raw of rows) {
    const { state, ...row } = camelRow(raw);
    const payload = { ...row, fields: snapshotFields(row) } as unknown as EmploymentPayloadRow;
    const effective =
      state === 'effective'
        ? await loadEmploymentRecord(tx, ctx.tenantId, payload.businessId, payload.effectiveDate)
        : null;
    if (state === 'effective' && !effective) continue;
    result.push({ payload, status: state as EmploymentState, values: effective ?? payload });
  }
  return result;
}

/** 调用方先锁员工；预览与写入都调用此服务，使用同一候选与替换规则。 */
export async function forwardUpdateEmployment(
  tx: Tx,
  ctx: EmploymentContext,
  source: ForwardSource,
  dryRun = false,
): Promise<ForwardPlan> {
  const plan: ForwardPlan = { changes: [], skipped: [], wholeRecordSkips: [] };
  const evaluationDate = source.evaluationDate ?? tenantLocalDate(ctx.now, ctx.timezone);
  const current = await currentEmploymentCycle(tx, ctx, source.employeeId, evaluationDate);
  if (current?.id !== source.staffId) {
    // 07 A2：只在当前任职周期内向后更新；旧周期补录已由 DEC-111 拒绝，这里只剩未来周期（Q-M0-26 待取证）。
    plan.skipped.push({ reason: 'NOT_CURRENT_EMPLOYMENT_CYCLE' });
    return plan;
  }
  const custom = (await getCustomFieldsForInheritance(tx, ctx.tenantId))
    .filter((field) => field.inherit)
    .map((field) => field.id);
  const targets = await candidates(tx, ctx, source);
  const cache = new Map<string, boolean>();
  for (const target of targets) {
    if (skipsWholeRecord(source.before, source.after, target.values)) {
      await remindWholeRecordSkip(tx, ctx, source, target, custom, cache, plan);
      continue;
    }
    const changes = matchingForwardChanges(source.before, source.after, target.values, custom);
    if (changes.length)
      await requireLinkedScope(
        tx,
        ctx,
        source.employeeId,
        target.values.fields.departmentId,
        target.payload.businessId,
      );
    const checkDate = referenceCheckDate(target.payload);
    const available = await availableForwardChanges(tx, ctx, changes, checkDate, cache, source.employeeId);
    if (available.skipped.length)
      plan.skipped.push({
        businessId: target.payload.businessId,
        reason: 'REFERENCE_UNAVAILABLE',
        fields: available.skipped,
      });
    // `19` §3.1 Q-M0-58：后续记录改成新经理会形成循环汇报时只跳过该字段，主记录照常保存（同引用不可用的处理）。
    if (available.cyclic.length)
      plan.skipped.push({ businessId: target.payload.businessId, reason: 'REPORTING_CYCLE', fields: available.cyclic });
    if (!available.accepted.length) continue;
    const nextValues = applyForwardChanges(target.values, available.accepted);
    await requireLinkedScope(tx, ctx, source.employeeId, nextValues.fields.departmentId, target.payload.businessId);
    if (!dryRun)
      await requireEmploymentWrite(
        ctx,
        'update',
        Object.fromEntries(available.accepted.map((change) => [change.field.replace(/^preset:/, ''), change.after])),
      );
    plan.changes.push({
      businessId: target.payload.businessId,
      staffId: source.staffId,
      status: target.status,
      fields: available.accepted,
    });
    if (!dryRun) {
      if (!source.businessId) throw new TypeError('向后更新必须关联触发业务');
      const next = await appendForwardPayload(
        tx,
        ctx,
        target.payload,
        applyForwardChanges(target.values, available.accepted),
        source.businessId,
        target.status === 'effective',
        available.accepted,
      );
      await auditForwardTarget(tx, ctx, next, available.accepted);
    }
  }
  return plan;
}

/** 不写入任何数据；只提醒当前数据范围内的记录，范围外的与无改动时一样静默跳过，不暴露其字段值。 */
async function remindWholeRecordSkip(
  tx: Tx,
  ctx: EmploymentContext,
  source: ForwardSource,
  target: ForwardTarget,
  custom: readonly string[],
  cache: Map<string, boolean>,
  plan: ForwardPlan,
): Promise<void> {
  const { businessId, effectiveDate } = target.payload;
  if (!(await linkedScopeAllows(tx, ctx, source.employeeId, target.values.fields.departmentId, businessId))) return;
  const reminders = wholeRecordSkipReminder(source.before, source.after, target.values, custom);
  const available = await availableForwardChanges(tx, ctx, reminders, referenceCheckDate(target.payload), cache);
  plan.wholeRecordSkips.push({
    businessId,
    staffId: source.staffId,
    status: target.status,
    effectiveDate,
    reason: 'DEPARTMENT_POSITION_MISMATCH',
    fields: available.accepted,
  });
}
