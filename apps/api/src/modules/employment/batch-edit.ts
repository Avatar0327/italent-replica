/**
 * 批量编辑任职记录（R1-T16，AC-AUD-03；原站组织员工对象操作日志的「批量编辑」，docs/02_业务建模/20 §3）。
 * 同一组字段写到多条有效任职记录，逐条复用单条编辑端口（字段校验、向后更新、人员同步、字段级审计都与单条一致）。
 * - 整体成功或整体失败（AGENTS.md §10「批量」）：任一条 revision 过期或校验失败，整单回滚，不留操作日志；
 * - 上限 100 条，同一记录不得在一单内重复出现；
 * - 取锁顺序（PR #50 / F-008：员工 → 业务 → 实例）：按（员工, 业务）排序后逐条加锁，并发的两单按同一顺序取锁；
 * - 成功时在对象操作日志记一条「批量编辑 / N条全部更新成功」，与业务同事务。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import { z } from 'zod';
import { recordOperationLog } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { normalizeBusinessPatch } from './fields.js';
import { editEmploymentRecord } from './record-edit.js';
import { rowsOf } from './record-store.js';
import type { EmploymentBusinessPatch, EmploymentContext } from './types.js';

export const MAX_BATCH_EDIT = 100;

const batchSchema = z.strictObject({
  items: z
    .array(z.strictObject({ id: z.string().refine(isUuid), revision: z.int().min(0) }))
    .min(1)
    .max(MAX_BATCH_EDIT),
  patch: z.unknown(),
});

export interface EmploymentBatchEdit {
  readonly items: readonly { readonly id: string; readonly revision: number }[];
  readonly patch: EmploymentBusinessPatch;
}

export function normalizeBatchEdit(value: unknown): EmploymentBatchEdit {
  const parsed = batchSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', `批量编辑须为 1～${MAX_BATCH_EDIT} 条任职记录`, parsed.error.issues);
  }
  const ids = parsed.data.items.map((item) => item.id.toLowerCase());
  if (new Set(ids).size !== ids.length) {
    throw new AppError('VALIDATION_FAILED', '同一条任职记录不能在一次批量编辑中重复出现', {
      reason: 'DUPLICATE_RECORD',
    });
  }
  return { items: parsed.data.items, patch: normalizeBusinessPatch(parsed.data.patch) };
}

export async function batchEditEmploymentRecords(tx: Tx, ctx: EmploymentContext, input: EmploymentBatchEdit) {
  const owners = await recordOwners(
    tx,
    ctx.tenantId,
    input.items.map((item) => item.id),
  );
  const ordered = [...input.items].sort((a, b) => {
    const left = owners.get(a.id.toLowerCase())!;
    const right = owners.get(b.id.toLowerCase())!;
    return left === right ? a.id.localeCompare(b.id) : left.localeCompare(right);
  });
  const saved = new Map<string, unknown>();
  for (const item of ordered) {
    saved.set(
      item.id,
      await editEmploymentRecord(tx, { ...ctx, expectedRevision: item.revision }, item.id, input.patch),
    );
  }
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    behavior: 'batch_update',
    objectType: 'employment-record',
    successCount: input.items.length,
    failureCount: 0,
    // 逐行归属（PR #75 第三轮 P1-2）：所属人员与记录部门，查询端按 DEC-177 逐行裁剪
    items: input.items.map((item, rowIndex) => ({
      rowIndex,
      outcome: 'succeeded' as const,
      objectId: item.id,
      employeeId: owners.get(item.id.toLowerCase()) ?? null,
      orgId: departmentOf(saved.get(item.id)),
    })),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  const total = input.items.length;
  return { total, succeeded: total, failed: 0, items: input.items.map((item) => saved.get(item.id)) };
}

function departmentOf(record: unknown): string | null {
  const fields = (record as { fields?: { departmentId?: unknown } } | undefined)?.fields;
  return typeof fields?.departmentId === 'string' ? fields.departmentId : null;
}

async function recordOwners(tx: Tx, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const list = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const rows = rowsOf<{ id: string; employeeId: string }>(
    await tx.execute(sql`SELECT id::text AS id, employee_id::text AS "employeeId" FROM employment_business_objects
      WHERE tenant_id = ${tenantId} AND id = ANY(${list})`),
  );
  const owners = new Map(rows.map((row) => [row.id.toLowerCase(), row.employeeId]));
  if (ids.some((id) => !owners.has(id.toLowerCase()))) throw new AppError('NOT_FOUND', '任职业务不存在');
  return owners;
}
