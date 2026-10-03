import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { requireScopedEmploymentObject, requireEmploymentWrite } from './context.js';
import { AppError } from '../../errors.js';
import { getCustomFieldsForInheritance } from './configuration.js';
import { findCurrentRecord, loadEmploymentRecord } from './read-model.js';
import { camelRow, rowsOf, snapshotFields, type EmploymentPayloadRow } from './record-store.js';
import {
  matchingForwardChanges,
  applyForwardChanges,
  type ForwardValues,
  type ForwardFieldChange,
} from './forward-rules.js';
import { availableForwardChanges } from './forward-references.js';
import { appendForwardPayload, auditForwardTarget } from './forward-store.js';
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
export interface ForwardPlan {
  readonly changes: ForwardChange[];
  readonly skipped: { readonly businessId?: string; readonly reason: string; readonly fields?: string[] }[];
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

/** 候选查询只访问已锁定员工的周期；超预算整体拒绝，绝不静默截断。 */
async function candidates(tx: Tx, ctx: EmploymentContext, source: ForwardSource): Promise<ForwardTarget[]> {
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
    WHERE b.tenant_id=${ctx.tenantId} AND b.employee_id=${source.employeeId}::uuid
      ${source.businessId ? sql`AND b.id<>${source.businessId}::uuid` : sql``}
      AND (r.staff_id=${source.staffId}::uuid OR (r.id IS NULL AND p.selected_staff_id=${source.staffId}::uuid))
      AND ((s.state='effective' AND p.effective_date>${source.effectiveDate}::date)
        OR (s.state IN ('draft','in_review','approved','rejected') AND p.effective_date>=${source.effectiveDate}::date))
    ORDER BY p.effective_date,b.id LIMIT ${TARGET_LIMIT + 1}
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
  const plan: ForwardPlan = { changes: [], skipped: [] };
  const current = await findCurrentRecord(
    tx,
    ctx.tenantId,
    source.employeeId,
    source.evaluationDate ?? tenantLocalDate(ctx.now, ctx.timezone),
  );
  if (current?.staffId !== source.staffId) {
    // TODO(需取证 Q-M0-26)：旧/未来周期补录是否属于“当前周期”待证；本轮不传播。
    plan.skipped.push({ reason: 'NOT_CURRENT_EMPLOYMENT_CYCLE' });
    return plan;
  }
  const custom = (await getCustomFieldsForInheritance(tx, ctx.tenantId)).filter((field) => field.inherit);
  const targets = await candidates(tx, ctx, source);
  const cache = new Map<string, boolean>();
  for (const target of targets) {
    const changes = matchingForwardChanges(
      source.before,
      source.after,
      target.values,
      custom.map((field) => field.id),
    );
    if (changes.length)
      await requireLinkedScope(
        tx,
        ctx,
        source.employeeId,
        target.values.fields.departmentId,
        target.payload.businessId,
      );
    const available = await availableForwardChanges(tx, ctx, changes, target.payload.effectiveDate, cache);
    if (available.skipped.length)
      plan.skipped.push({
        businessId: target.payload.businessId,
        reason: 'REFERENCE_UNAVAILABLE',
        fields: available.skipped,
      });
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
