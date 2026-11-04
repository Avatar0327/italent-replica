/** DEC-799：待办卡片独立查询；不改变我的申请实例查询。分页、计数共用一份可见候选集。 */
import { sql, type Tx } from '@italent/db';
import { APPROVAL_TYPES, isApprovalType } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { rowsOf, type ApprovalContext } from './context.js';
import type { Page } from './queries.js';
import { withActorNames } from './store.js';
import { visibleRecordSql, type DetailView } from './disclosure.js';

const categories = [
  { key: 'employment', label: '人事变动' },
  { key: 'offer', label: 'Offer' },
  { key: 'personal', label: '个人信息变更' },
  { key: 'development', label: '盘点发展' },
  { key: 'other', label: '其他' },
] as const;
type Category = (typeof categories)[number]['key'];
function categoryOf(code: string): Category {
  if (!isApprovalType(code)) return 'other';
  const adapter = APPROVAL_TYPES[code].adapter;
  if (['employment', 'contract', 'part_time', 'retirement_intention', 'exit_handover', 'assessment'].includes(adapter))
    return 'employment';
  if (['offer', 'offer_batch'].includes(adapter)) return 'offer';
  if (['employee_info', 'personnel_change'].includes(adapter)) return 'personal';
  if (['idp', 'talent_review'].includes(adapter)) return 'development';
  return 'other';
}
const querySchema = z.object({
  view: z.enum(['pending', 'completed', 'initiated']),
  category: z.enum(['employment', 'offer', 'personal', 'development', 'other']).optional(),
});
export function todoCardsQuery(value: Record<string, string>) {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '待办查询条件不合法');
  return parsed.data;
}
interface CardRow {
  id: string;
  title: string;
  status: string;
  approval_type: string;
  initiator_user_id: string;
  task_id: string | null;
  node_key: string | null;
  node_name: string | null;
  is_exception_admin: boolean;
  created_at: string;
}

export async function listTodoCards(
  tx: Tx,
  ctx: ApprovalContext,
  query: ReturnType<typeof todoCardsQuery>,
  page: Page,
  project: (id: string) => Promise<DetailView>,
  summarize: (detail: DetailView) => Promise<{ key: string; label: string; value: string }[]>,
) {
  const { tenantId, userId } = ctx;
  const history = query.view !== 'pending';
  const taskSource =
    query.view === 'completed'
      ? sql`SELECT l.id,l.node_key,l.created_at,l.created_at AS acted_at
        FROM approval_instance_logs l WHERE l.tenant_id=i.tenant_id AND l.instance_id=i.id
        AND l.actor_user_id=${userId}::uuid
        AND l.event IN ('approve','disagree','reject','reject_previous','jump','transfer','add_sign_before','add_sign_after')
        ORDER BY l.created_at DESC,l.id DESC LIMIT 1`
      : sql`SELECT t.* FROM approval_tasks t WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id
        AND t.assignee_user_id=${userId}::uuid AND t.status='pending'
        AND ${query.view === 'pending'}`;
  const time = { pending: sql`t.created_at`, completed: sql`t.acted_at`, initiated: sql`i.created_at` }[query.view];
  const category = sql`CASE i.approval_type ${sql.join(
    Object.keys(APPROVAL_TYPES).map((code) => sql`WHEN ${code} THEN ${categoryOf(code)}`),
    sql` `,
  )} ELSE 'other' END`;
  // 已处理取本人办理日志，不能以 acted_at 判定（系统撤销/会签结束也会写此时间）；当前待办保留。
  const [result] = rowsOf<{ items: CardRow[]; total: number; counts: { key: Category; count: number }[] }>(
    await tx.execute(sql`WITH candidates AS MATERIALIZED (
      SELECT i.id,i.title,i.status,i.approval_type,i.initiator_user_id,
        t.id AS task_id,t.node_key,n.name AS node_name,${category} AS category,
        ${query.view === 'pending' ? sql`t.is_exception_admin` : sql`false`} AS is_exception_admin,
        ${time} AS created_at
      FROM approval_instances i
      LEFT JOIN LATERAL (${taskSource}) t ON true
      LEFT JOIN approval_process_nodes n ON n.tenant_id=i.tenant_id AND n.version_id=i.version_id AND n.node_key=t.node_key
      WHERE i.tenant_id=${tenantId} AND ${query.view === 'initiated' ? sql`i.initiator_user_id=${userId}::uuid` : sql`t.id IS NOT NULL`}
        ${history ? sql`AND ${visibleRecordSql(userId)}` : sql``}
    ), filtered AS MATERIALIZED (SELECT * FROM candidates ${query.category ? sql`WHERE category=${query.category}` : sql``}),
    paged AS (SELECT * FROM filtered ORDER BY created_at DESC,id,task_id LIMIT ${page.limit} OFFSET ${page.offset})
    SELECT COALESCE((SELECT jsonb_agg(p ORDER BY p.created_at DESC,p.id,p.task_id) FROM paged p),'[]'::jsonb) AS items,
      (SELECT count(*) FROM filtered) AS total,
      COALESCE((SELECT jsonb_agg(c) FROM (SELECT category AS key,count(*) AS count FROM filtered GROUP BY category) c),'[]'::jsonb) AS counts`),
  );
  const names = await withActorNames(
    tx,
    result!.items.map((row) => ({ actorUserId: row.initiator_user_id })),
  );
  const items = [];
  for (const [index, row] of result!.items.entries()) {
    const detail = await project(row.id);
    items.push({
      id: row.id,
      instanceId: row.id,
      title: row.title,
      status: row.status,
      approvalType: row.approval_type,
      ...(query.view === 'pending' && row.task_id ? { taskId: row.task_id } : {}),
      nodeKey: row.node_key,
      ...(row.node_name ? { nodeName: row.is_exception_admin ? `${row.node_name}（异常管理员）` : row.node_name } : {}),
      isExceptionAdmin: row.is_exception_admin,
      createdAt: new Date(row.created_at).toISOString(),
      initiatorName: names[index]!.actorName,
      summary: await summarize(detail),
    });
  }
  return {
    items,
    total: Number(result!.total),
    categories: categories.map((c) => ({
      ...c,
      count: Number(result!.counts.find((entry) => entry.key === c.key)?.count ?? 0),
    })),
  };
}
