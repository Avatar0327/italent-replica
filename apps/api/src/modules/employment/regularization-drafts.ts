/**
 * 转正申请暂存（F-347；docs/02_业务建模/29 补充 DEC-709 / DEC-713）：
 * - 按 员工 × 表单（首期只有标准表单）每人一份，再暂存覆盖上一份；If-Match = 暂存 revision（没有时 0）；
 * - 不校验必填、不建业务单、不发起审批，所以不进「我的申请」；内容只在服务端，换浏览器 / 换设备都能读回；
 * - 暂存锚定本周期的开启记录：周期换了（再入职、实习转正）旧内容视为没有暂存；
 * - 转正申请提交成功后清空（复刻自己的设计，北森未见）；不提供删除入口，「点击清除」只在前端重置表单；
 * - 跨操作人共享：有该员工的转正申请权限且在其数据范围内即可读写同一份（北森未测，复刻口径，写进未决）。
 * 同一份读投影还带 applicationId：本周期最近一张停在草稿的转正申请（含撤回回草稿的），前端据此同单重提（DEC-103），
 * 取代原先记在本机存储里的草稿指针。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { assertRevision, auditEmployment } from './context.js';
import { parse } from './entry-routes.js';
import { loadProbationCycle } from './probation.js';
import { requireEnabledProbationEntry } from './probation-results.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

const FORM = 'standard';
const draftInput = z.strictObject({
  effectiveDate: z.iso.date().nullable().optional(),
  probationResult: z.string().trim().min(1).max(100).nullable().optional(),
});

export interface RegularizationDraftView {
  /** 读回核对用：暂存挂在员工上，id 即员工 ID。 */
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly temporary: {
    readonly effectiveDate: string | null;
    readonly probationResult: string | null;
    readonly probationResultName: string | null;
    readonly savedAt: string;
  } | null;
  readonly applicationId: string | null;
}

interface DraftRow {
  readonly revision: number;
  readonly saved: boolean;
  readonly anchor_id: string | null;
  readonly effective_date: string | null;
  readonly probation_result: string | null;
  readonly result_name: string | null;
  readonly updated_at: string;
}

/** 在职才有暂存：不在职（未入职、已离职）与员工不存在同样 404。 */
async function currentAnchor(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const cycle = await loadProbationCycle(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  if (!cycle) throw new AppError('NOT_FOUND', '任职数据不存在');
  return cycle.anchor;
}

async function draftRow(tx: Tx, tenantId: string, employeeId: string, lock: boolean) {
  const [row] = rowsOf<DraftRow>(
    await tx.execute(sql`
    SELECT d.revision, d.saved, d.anchor_id, d.effective_date::text AS effective_date, d.probation_result,
      r.name AS result_name, d.updated_at
    FROM employment_regularization_drafts d
    LEFT JOIN employment_probation_results r ON r.tenant_id=d.tenant_id AND lower(r.code)=lower(d.probation_result)
    WHERE d.tenant_id=${tenantId} AND d.employee_id=${employeeId}::uuid AND d.form_id=${FORM}
    ${lock ? sql`FOR UPDATE OF d` : sql``}`),
  );
  return row;
}

/** 本周期最近一张停在草稿的转正申请（同 cycleRegularization 的周期口径：记录或载荷上的任职 staff 一致）。 */
async function pendingApplication(tx: Tx, tenantId: string, employeeId: string, staffId: string) {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT b.id FROM employment_business_objects b
    JOIN LATERAL (SELECT p.* FROM employment_payload_versions p WHERE p.tenant_id=b.tenant_id
      AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT s.state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id
      AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_records rg ON rg.tenant_id=b.tenant_id AND rg.id=b.id
    WHERE b.tenant_id=${tenantId} AND b.employee_id=${employeeId}::uuid AND p.kind='regularization'
      AND p.mode='application' AND s.state='draft' AND COALESCE(rg.staff_id, p.selected_staff_id)=${staffId}
    ORDER BY b.created_at DESC, b.id DESC LIMIT 1`),
  );
  return row?.id ?? null;
}

function view(
  employeeId: string,
  row: DraftRow | undefined,
  anchorId: string,
  applicationId: string | null,
): RegularizationDraftView {
  const live = row?.saved === true && row.anchor_id === anchorId;
  return {
    id: employeeId,
    employeeId,
    revision: row ? Number(row.revision) : 0,
    temporary: live
      ? {
          effectiveDate: row.effective_date,
          probationResult: row.probation_result,
          probationResultName: row.probation_result === null ? null : row.result_name,
          savedAt: new Date(row.updated_at).toISOString(),
        }
      : null,
    applicationId,
  };
}

export async function loadRegularizationDraft(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
): Promise<RegularizationDraftView> {
  const anchor = await currentAnchor(tx, ctx, employeeId);
  const row = await draftRow(tx, ctx.tenantId, employeeId, false);
  return view(employeeId, row, anchor.id, await pendingApplication(tx, ctx.tenantId, employeeId, anchor.staffId));
}

/** 暂存（覆盖写）：不校验必填；填了试用结果须是启用项，存库里的编码写法。 */
export async function saveRegularizationDraft(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  raw: unknown,
): Promise<RegularizationDraftView> {
  const input = parse(draftInput, raw);
  const anchor = await currentAnchor(tx, ctx, employeeId);
  const before = await draftRow(tx, ctx.tenantId, employeeId, true);
  assertRevision(ctx.expectedRevision, before ? Number(before.revision) : 0);
  const result = input.probationResult
    ? (await requireEnabledProbationEntry(tx, ctx.tenantId, input.probationResult)).code
    : null;
  const effectiveDate = input.effectiveDate ?? null;
  const at = ctx.now.toISOString();
  await tx.execute(sql`
    INSERT INTO employment_regularization_drafts(tenant_id, employee_id, form_id, anchor_id, saved, effective_date,
      probation_result, revision, saved_by_user_id, command_id, updated_at)
    VALUES (${ctx.tenantId}, ${employeeId}::uuid, ${FORM}, ${anchor.id}::uuid, true, ${effectiveDate}::date,
      ${result}, 1, ${auditActor(ctx.userId)}::uuid, ${ctx.commandId}, ${at}::timestamptz)
    ON CONFLICT (tenant_id, employee_id, form_id) DO UPDATE SET anchor_id=EXCLUDED.anchor_id, saved=true,
      effective_date=EXCLUDED.effective_date, probation_result=EXCLUDED.probation_result,
      revision=employment_regularization_drafts.revision + 1, saved_by_user_id=EXCLUDED.saved_by_user_id,
      command_id=EXCLUDED.command_id, updated_at=EXCLUDED.updated_at`);
  await auditEmployment(
    tx,
    ctx,
    'employment.regularization.draft.save',
    'employment_employee',
    employeeId,
    before?.saved ? { effectiveDate: before.effective_date, probationResult: before.probation_result } : null,
    { effectiveDate, probationResult: result },
    undefined,
    undefined,
    { employeeId },
  );
  return loadRegularizationDraft(tx, ctx, employeeId);
}

/** 转正申请提交成功：清空这名员工的暂存内容（保留行与 revision 递增，旧页面再暂存会 409）。 */
export async function clearRegularizationDraft(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const before = await draftRow(tx, ctx.tenantId, employeeId, true);
  if (!before?.saved) return;
  await tx.execute(sql`
    UPDATE employment_regularization_drafts SET saved=false, effective_date=NULL, probation_result=NULL,
      revision=revision + 1, command_id=${ctx.commandId}, updated_at=${ctx.now.toISOString()}::timestamptz
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND form_id=${FORM}`);
  await auditEmployment(
    tx,
    ctx,
    'employment.regularization.draft.clear',
    'employment_employee',
    employeeId,
    { effectiveDate: before.effective_date, probationResult: before.probation_result },
    null,
    undefined,
    undefined,
    { employeeId },
  );
}

/** 转正申请提交成功（同事务，提交失败则暂存仍在）：清掉这名员工的暂存；其他业务不动。 */
export async function clearSubmittedRegularizationDraft(
  tx: Tx,
  ctx: EmploymentContext,
  business: { readonly employeeId: string; readonly payload: { readonly kind: string } },
) {
  if (business.payload.kind === 'regularization') await clearRegularizationDraft(tx, ctx, business.employeeId);
}
