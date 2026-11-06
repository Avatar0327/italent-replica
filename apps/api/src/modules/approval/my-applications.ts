/** F-474-3b：我的申请列表投影（原站 §2.10）。只含本人发起的实例；筛选、排序、总数共用一份条件，不改 listInstances。 */
import { sql, type Tx } from '@italent/db';
import { APPROVAL_TYPES, isApprovalType } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { rowsOf } from './context.js';
import type { Page } from './queries.js';
import { withActorNames } from './store.js';

const STATUSES = ['running', 'approved', 'disapproved', 'cancelled', 'returned', 'withdrawn'] as const;
const list = <T extends string>(allowed: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.enum(allowed)).max(allowed.length))
    .optional();
const querySchema = z.object({
  view: z.literal('applications'),
  category: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.string().refine(isApprovalType)).max(Object.keys(APPROVAL_TYPES).length))
    .optional(),
  status: list(STATUSES),
  sort: z.enum(['createdAt', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).optional(),
});
export type MyApplicationsQuery = z.infer<typeof querySchema>;

export function myApplicationsQuery(value: Record<string, string>): MyApplicationsQuery {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '我的申请查询条件不合法');
  return parsed.data;
}

// 审批状态排序按界面选项顺序（审批中在前），而不是状态码的字母序。
const statusRank = sql`CASE i.status ${sql.join(
  STATUSES.map((status, index) => sql`WHEN ${status} THEN ${index}`),
  sql` `,
)} ELSE ${STATUSES.length} END`;

function orderBy(query: MyApplicationsQuery) {
  const direction = query.order === 'asc' ? sql`ASC` : sql`DESC`;
  if (query.sort === 'status') {
    // 状态相同的按申请时间倒序，翻页稳定
    return sql`${statusRank} ${query.order === 'desc' ? sql`DESC` : sql`ASC`},i.created_at DESC,i.id`;
  }
  // 同一时刻创建的并列项，id 方向跟随，保证升序恰为降序的反序
  return sql`i.created_at ${direction},i.id ${direction}`;
}

interface Row {
  id: string;
  title: string;
  status: string;
  approval_type: string;
  initiator_user_id: string;
  created_at: string;
}

/** 当前处理人 = 运行中实例的待办任务办理人（DEC-115：PC 仍显示当前待办人）；已结束的实例为空。 */
async function currentHandlers(tx: Tx, tenantId: string, rows: readonly Row[]) {
  const running = rows.filter((row) => row.status === 'running').map((row) => row.id);
  const byInstance = new Map<string, string[]>();
  if (!running.length) return byInstance;
  const tasks = rowsOf<{ instance_id: string; assignee_user_id: string }>(
    await tx.execute(sql`SELECT t.instance_id,t.assignee_user_id FROM approval_tasks t
      WHERE t.tenant_id=${tenantId} AND t.status='pending'
        AND t.instance_id IN (${sql.join(
          running.map((id) => sql`${id}::uuid`),
          sql`,`,
        )})
      ORDER BY t.created_at,t.id`),
  );
  const named = await withActorNames(
    tx,
    tasks.map((task) => ({ instanceId: task.instance_id, actorUserId: task.assignee_user_id })),
  );
  for (const task of named) {
    const names = byInstance.get(task.instanceId) ?? [];
    if (task.actorName && !names.includes(task.actorName)) names.push(task.actorName);
    byInstance.set(task.instanceId, names);
  }
  return byInstance;
}

export async function listMyApplications(
  tx: Tx,
  tenantId: string,
  userId: string,
  query: MyApplicationsQuery,
  page: Page,
) {
  const where = sql`i.tenant_id=${tenantId} AND i.initiator_user_id=${userId}::uuid
    ${
      query.category?.length
        ? sql`AND i.approval_type IN (${sql.join(
            query.category.map((code) => sql`${code}`),
            sql`,`,
          )})`
        : sql``
    }
    ${
      query.status?.length
        ? sql`AND i.status IN (${sql.join(
            query.status.map((status) => sql`${status}`),
            sql`,`,
          )})`
        : sql``
    }`;
  const rows = rowsOf<Row>(
    await tx.execute(sql`SELECT i.id,i.title,i.status,i.approval_type,i.initiator_user_id,i.created_at
      FROM approval_instances i WHERE ${where}
      ORDER BY ${orderBy(query)} LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  const [count] = rowsOf<{ total: number }>(
    await tx.execute(sql`SELECT count(*) AS total FROM approval_instances i WHERE ${where}`),
  );
  const names = await withActorNames(
    tx,
    rows.map((row) => ({ actorUserId: row.initiator_user_id })),
  );
  const handlers = await currentHandlers(tx, tenantId, rows);
  const items = rows.map((row, index) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    approvalType: row.approval_type,
    approvalTypeName: isApprovalType(row.approval_type) ? APPROVAL_TYPES[row.approval_type].name : row.approval_type,
    initiatorName: names[index]!.actorName,
    currentHandlers: handlers.get(row.id) ?? [],
    createdAt: new Date(row.created_at).toISOString(),
  }));
  return { items, total: Number(count!.total) };
}
