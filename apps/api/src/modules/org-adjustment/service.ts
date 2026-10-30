/**
 * 组织调整单一写服务的头部分（R2-T08 §6.1，BE-10b1）：建单、改头、作废、整单校验。组织明细见 org-items.ts、
 * 刷新基线见 baseline.ts（10b2）；提交 / 撤回随 10c。
 * 每次写：锁申请单行 → 校验 revision → 申请人与状态（§3：只有 0 已暂存 / 6 已驳回可改、可作废）→ 生效日组织可用 →
 * 写头与调整范围（整体替换、去重保序）→ revision + 1 → 同事务审计。授权由调用方在命令守卫里先判（access.ts）。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { rowsOf } from '../org/read-model.js';
import { checkOrgItems } from './item-check.js';
import { loadWorld, OUT_OF_RANGE, outOfRange } from './item-tree.js';
import { assertOrgsActive, inactiveOrgs, ORG_INACTIVE } from './range.js';
import type { HeadInput, HeadPatch } from './validation.js';

export interface WriteContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly timezone: string;
  readonly expectedRevision: number;
  readonly now: Date;
  readonly commandId: string;
}

export interface AdjustmentView {
  readonly id: string;
  readonly code: string;
  readonly subject: string;
  readonly effectiveDate: string;
  readonly content: string | null;
  readonly approvalSubjectOrgId: string;
  readonly adjustmentRange: string[];
  readonly approvalStatus: number;
  readonly executionStatus: number;
  readonly createdBy: string;
  readonly revision: number;
}

const DRAFT = 0;
const IN_REVIEW = 1;
const VOIDED = 5;
const REJECTED = 6;

/** 申请单头 + 调整范围；`lock` 时对申请单行 FOR UPDATE（锁序 ③）。不存在 → undefined。 */
export async function loadAdjustment(tx: Tx, tenantId: string, id: string, lock = false) {
  const [row] = rowsOf<Omit<AdjustmentView, 'adjustmentRange'>>(
    await tx.execute(sql`
      SELECT id, code, subject, effective_date::text AS "effectiveDate", content,
        approval_subject_org_id AS "approvalSubjectOrgId", approval_status AS "approvalStatus",
        execution_status AS "executionStatus", created_by AS "createdBy", revision
      FROM org_adjustments WHERE tenant_id = ${tenantId} AND id = ${id}
      ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) return undefined;
  const range = rowsOf<{ org_id: string }>(
    await tx.execute(sql`SELECT org_id FROM org_adjustment_range_orgs
      WHERE tenant_id = ${tenantId} AND adjustment_id = ${id} ORDER BY seq`),
  );
  return { ...row, adjustmentRange: range.map((r) => r.org_id) } satisfies AdjustmentView;
}

export async function createAdjustment(tx: Tx, ctx: WriteContext, input: HeadInput): Promise<AdjustmentView> {
  await assertOrgsActive(tx, ctx.tenantId, [input.approvalSubjectOrgId, ...input.adjustmentRange], input.effectiveDate);
  const code = await nextCode(tx, ctx);
  const now = ctx.now.toISOString();
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`
      INSERT INTO org_adjustments (tenant_id, code, subject, effective_date, content, approval_subject_org_id,
        approval_status, execution_status, created_by, revision, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${code}, ${input.subject}, ${input.effectiveDate}::date, ${input.content ?? null},
        ${input.approvalSubjectOrgId}, ${DRAFT}, 1, ${ctx.userId}, 1, ${now}, ${now})
      RETURNING id`),
  );
  await writeRange(tx, ctx.tenantId, row!.id, input.adjustmentRange);
  const view = (await loadAdjustment(tx, ctx.tenantId, row!.id))!;
  await audit(tx, ctx, 'org-adjustment.create', null, view);
  return view;
}

export async function updateAdjustmentHead(
  tx: Tx,
  ctx: WriteContext,
  id: string,
  patch: HeadPatch,
): Promise<AdjustmentView> {
  const before = await editable(tx, ctx, id);
  const next = { ...before, ...patch };
  await assertOrgsActive(tx, ctx.tenantId, [next.approvalSubjectOrgId, ...next.adjustmentRange], next.effectiveDate);
  if (patch.adjustmentRange || patch.effectiveDate) await assertItemsInRange(tx, ctx.tenantId, next);
  await tx.execute(sql`
    UPDATE org_adjustments SET subject = ${next.subject}, effective_date = ${next.effectiveDate}::date,
      content = ${next.content ?? null}, approval_subject_org_id = ${next.approvalSubjectOrgId},
      revision = revision + 1, updated_at = ${ctx.now.toISOString()}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}`);
  if (patch.adjustmentRange) {
    await tx.execute(
      sql`DELETE FROM org_adjustment_range_orgs WHERE tenant_id = ${ctx.tenantId} AND adjustment_id = ${id}`,
    );
    await writeRange(tx, ctx.tenantId, id, patch.adjustmentRange);
  }
  const view = (await loadAdjustment(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'org-adjustment.update', before, view);
  return view;
}

/** 作废：0 / 6 → 5，不物理删除（§3）。 */
export async function voidAdjustment(tx: Tx, ctx: WriteContext, id: string): Promise<AdjustmentView> {
  const before = await editable(tx, ctx, id);
  await tx.execute(sql`
    UPDATE org_adjustments SET approval_status = ${VOIDED}, revision = revision + 1,
      updated_at = ${ctx.now.toISOString()}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}`);
  const view = (await loadAdjustment(tx, ctx.tenantId, id))!;
  await audit(tx, ctx, 'org-adjustment.void', before, view);
  return view;
}

/** 改头改范围或生效日：已有明细（含新上级）须仍在范围内（§5.6），否则 400 并列出明细，不写。 */
async function assertItemsInRange(tx: Tx, tenantId: string, next: AdjustmentView) {
  const world = await loadWorld(tx, tenantId, next);
  const misses = outOfRange(world, world.items, next.adjustmentRange);
  if (misses.length) {
    throw new AppError('VALIDATION_FAILED', '已有明细不在新的调整范围内', {
      reason: OUT_OF_RANGE,
      items: misses.map((miss) => ({ section: 'org', ...miss })),
    });
  }
}

const CHECK_LIMIT = 200;

/** 整单只读校验（路由 7）：主体组织与调整范围在生效日可用 + 组织明细（item-check）；信封最多 200 条，超出标 truncated。 */
export async function checkAdjustment(tx: Tx, tenantId: string, view: AdjustmentView) {
  const orgIds = await inactiveOrgs(
    tx,
    tenantId,
    [view.approvalSubjectOrgId, ...view.adjustmentRange],
    view.effectiveDate,
  );
  const items = await checkOrgItems(tx, await loadWorld(tx, tenantId, view));
  const all = [...(orgIds.length > 0 ? [{ reason: ORG_INACTIVE, orgIds }] : []), ...items];
  const errors = all.slice(0, CHECK_LIMIT);
  return { valid: all.length === 0, errors, warnings: [], ...(all.length > CHECK_LIMIT && { truncated: true }) };
}

/** 锁行 → revision → 申请人 → 状态；返回改前视图。 */
export async function editable(tx: Tx, ctx: WriteContext, id: string): Promise<AdjustmentView> {
  const row = await loadAdjustment(tx, ctx.tenantId, id, true);
  if (!row) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  if (row.revision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '申请单已被修改，请刷新后重试');
  if (row.createdBy !== ctx.userId) {
    throw new AppError('FORBIDDEN', '只有申请人可以修改或作废申请单', { reason: 'ORG_ADJUSTMENT_NOT_APPLICANT' });
  }
  if (row.approvalStatus === IN_REVIEW) {
    throw new AppError('CONFLICT', '申请单审批中，不能修改', { reason: 'ORG_ADJUSTMENT_IN_REVIEW' });
  }
  if (row.approvalStatus !== DRAFT && row.approvalStatus !== REJECTED) {
    throw new AppError('CONFLICT', '申请单当前状态不能修改', { reason: 'ORG_ADJUSTMENT_NOT_EDITABLE' });
  }
  return row;
}

async function writeRange(tx: Tx, tenantId: string, id: string, orgIds: readonly string[]) {
  for (const [index, orgId] of orgIds.entries()) {
    await tx.execute(sql`INSERT INTO org_adjustment_range_orgs (tenant_id, adjustment_id, org_id, seq)
      VALUES (${tenantId}, ${id}, ${orgId}, ${index + 1})`);
  }
}

/** 单据编码 OA + 租户当地日期 yyyymmdd + 当日 4 位流水；按租户加锁取号（未证原站规则，见结果文件“未决 / 假设”）。 */
async function nextCode(tx: Tx, ctx: WriteContext): Promise<string> {
  await advisoryLock(tx, 'org-adjustment-code:', asUuid(ctx.tenantId));
  const prefix = `OA${tenantLocalDate(ctx.now, ctx.timezone).replaceAll('-', '')}`;
  const [row] = rowsOf<{ last: string | null }>(
    await tx.execute(sql`SELECT max(code) AS last FROM org_adjustments
      WHERE tenant_id = ${ctx.tenantId} AND code ~ ${`^${prefix}[0-9]{4}$`}`),
  );
  const seq = row?.last ? Number(row.last.slice(prefix.length)) + 1 : 1;
  if (seq > 9999) throw new AppError('CONFLICT', '当日申请单编码已用完');
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

function audit(tx: Tx, ctx: WriteContext, action: string, before: AdjustmentView | null, after: AdjustmentView) {
  return recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    action,
    objectType: 'org-adjustment',
    objectId: after.id,
    before,
    after,
    commandId: ctx.commandId || null,
    scope: { orgId: after.approvalSubjectOrgId },
  });
}
