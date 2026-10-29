/**
 * R2 BE-8b1 离职交接事项设置（B64 设置页；DEC-266③、规格 30 第 182 行）：事项类别、序号、待办类别（工作交接 / 其他）、待办事项、
 * 事项办理表单（只存文本或表单标识）、备注。没有适用人群与负责人（办理人由交接流程会签节点决定，归 BE-8b2）；不预置原站 30 项，不做复制。
 * 挂在任职设置配置对象上（tenant.employment.configuration.write，管理员 other_settings），审计 exit_handover_item.*（DEC-203 配置日志）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  HANDOVER_CATEGORY_MAX,
  HANDOVER_FORM_REF_MAX,
  HANDOVER_ITEM_LIMIT,
  HANDOVER_REMARK_MAX,
  HANDOVER_TITLE_MAX,
  HANDOVER_TODO_TYPE_CODES,
} from '@italent/domain';
import { z } from 'zod';
import { advisoryLock, asUuid } from '../../advisory-lock.js';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { assertRevision } from './context.js';
import { exitListOrder } from './exit-list-order.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export const HANDOVER_ITEM_AUDIT_TYPE = 'exit_handover_item';

export interface HandoverItemView {
  readonly id: string;
  readonly category: string;
  readonly sequenceNo: number;
  readonly todoType: string;
  readonly title: string;
  readonly formRef: string | null;
  readonly remark: string | null;
  readonly revision: number;
}

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const itemInput = z.strictObject({
  category: z.string().trim().min(1).max(HANDOVER_CATEGORY_MAX),
  sequenceNo: z.int().min(1).max(9999),
  todoType: z.enum(HANDOVER_TODO_TYPE_CODES),
  title: z.string().trim().min(1).max(HANDOVER_TITLE_MAX),
  formRef: optionalText(HANDOVER_FORM_REF_MAX),
  remark: optionalText(HANDOVER_REMARK_MAX),
});
export type HandoverItemInput = z.infer<typeof itemInput>;

export function parseHandoverItem(raw: unknown): HandoverItemInput {
  const parsed = itemInput.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '离职交接事项字段不合法', parsed.error.issues);
  return parsed.data;
}

const COLUMNS = sql`id, category, sequence_no AS "sequenceNo", todo_type AS "todoType", title, form_ref AS "formRef",
  remark, revision`;

/** 按序号再按创建顺序排列（同序号不报错：原站序号唯一性未验证，取最保守的不限制）。 */
export async function listHandoverItems(tx: Tx, tenantId: string, itemId?: string): Promise<HandoverItemView[]> {
  return rowsOf<HandoverItemView>(
    await tx.execute(sql`SELECT ${COLUMNS} FROM exit_handover_items WHERE tenant_id = ${tenantId}
      ${itemId ? sql`AND id = ${itemId}::uuid` : sql``}
      ORDER BY ${exitListOrder('handoverItems').order} LIMIT ${HANDOVER_ITEM_LIMIT}`),
  );
}

async function lockItems(tx: Tx, tenantId: string) {
  await advisoryLock(tx, asUuid(tenantId), ':exit-handover-items');
}

async function audit(tx: Tx, ctx: EmploymentContext, action: string, id: string, before: unknown, after: unknown) {
  await recordAudit(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    action: `${HANDOVER_ITEM_AUDIT_TYPE}.${action}`,
    objectType: HANDOVER_ITEM_AUDIT_TYPE,
    objectId: id,
    before,
    after,
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
}

async function lockedItem(tx: Tx, ctx: EmploymentContext, id: string) {
  const [before] = await listHandoverItems(tx, ctx.tenantId, id);
  if (!before) throw new AppError('NOT_FOUND', '离职交接事项不存在');
  assertRevision(ctx.expectedRevision, before.revision);
  return before;
}

/** 新增（If-Match 0）或整份保存（If-Match = 当前 revision）一条交接事项；每租户最多 200 条。 */
export async function saveHandoverItem(
  tx: Tx,
  ctx: EmploymentContext,
  input: HandoverItemInput,
  id?: string,
): Promise<HandoverItemView> {
  await lockItems(tx, ctx.tenantId);
  const before = id ? await lockedItem(tx, ctx, id) : null;
  const itemId = id ?? randomUUID();
  const now = ctx.now.toISOString();
  if (!before) {
    assertRevision(ctx.expectedRevision, 0);
    const [count] = rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM exit_handover_items WHERE tenant_id = ${ctx.tenantId}`),
    );
    if (count!.n >= HANDOVER_ITEM_LIMIT)
      throw new AppError('CONFLICT', '离职交接事项已达上限', {
        reason: 'HANDOVER_ITEM_LIMIT_REACHED',
        limit: HANDOVER_ITEM_LIMIT,
      });
    await tx.execute(sql`INSERT INTO exit_handover_items(id, tenant_id, category, sequence_no, todo_type, title,
      form_ref, remark, created_at, updated_at)
      VALUES (${itemId}::uuid, ${ctx.tenantId}, ${input.category}, ${input.sequenceNo}, ${input.todoType},
      ${input.title}, ${input.formRef || null}, ${input.remark || null}, ${now}::timestamptz, ${now}::timestamptz)`);
  } else {
    await tx.execute(sql`UPDATE exit_handover_items SET category = ${input.category}, sequence_no = ${input.sequenceNo},
      todo_type = ${input.todoType}, title = ${input.title}, form_ref = ${input.formRef || null},
      remark = ${input.remark || null}, revision = revision + 1, updated_at = ${now}::timestamptz
      WHERE tenant_id = ${ctx.tenantId} AND id = ${itemId}::uuid`);
  }
  const [after] = await listHandoverItems(tx, ctx.tenantId, itemId);
  await audit(tx, ctx, before ? 'update' : 'create', itemId, before, after);
  return after!;
}

export async function deleteHandoverItem(tx: Tx, ctx: EmploymentContext, id: string) {
  await lockItems(tx, ctx.tenantId);
  const before = await lockedItem(tx, ctx, id);
  await tx.execute(sql`DELETE FROM exit_handover_items WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid`);
  await audit(tx, ctx, 'delete', id, before, null);
  return { id, deleted: true };
}
