/**
 * 同一业务对象有多个审批实例时的“办理份”稳定读选择（F-476 设计 §1.2、§5.4；P8 IDP 的阶段、P9 的交接共用）。
 * 一个业务对象（如 IDP 计划）每个阶段是一个审批实例：读取方给出该对象的全部实例，再按需给出指定的实例（上下文）。
 * - 指定实例：必须在给定的实例里（否则 404，不泄露别处是否存在），只在该实例内按 selectContent 选；
 * - 不指定：先看本人是否在某个实例有待办（现值），再看本人最近一次办理（跨实例，按办理时间倒序，
 *   并列依次比实例创建时间、实例 ID、日志序号），最后是现值（instanceId 为空）。
 * 选定实例后的 现值 / 办理份 判定一律交给 selectContent（发起人、待办、缺份 503 的规则不在这里重复）。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf, type ApprovalContext } from './context.js';
import { type ContentSelection, contentViewOf, HANDLING_EVENTS, selectContent } from './handling-content.js';
import { loadInstance, loadTasks } from './store.js';

export interface StableRead {
  /** 选中的审批实例；本人既没有待办也没有办理记录时为空（现值）。 */
  readonly instanceId: string | null;
  readonly selection: ContentSelection;
}

const LIVE: StableRead = { instanceId: null, selection: { mode: 'live' } };

const uuidArray = (ids: readonly string[]) => `{${ids.join(',')}}`;

async function inInstance(
  tx: Tx,
  ctx: Pick<ApprovalContext, 'tenantId'>,
  instanceId: string,
  userId: string,
): Promise<StableRead> {
  const instance = await loadInstance(tx, ctx.tenantId, instanceId);
  const tasks = await loadTasks(tx, ctx.tenantId, instanceId);
  return { instanceId, selection: await selectContent(tx, ctx, instance, tasks, userId) };
}

/** 本人在这些实例里最先出现的在办待办所在实例（自审 / 主体跳过的留痕不算）。 */
async function pendingInstance(tx: Tx, tenantId: string, ids: readonly string[], userId: string) {
  const [row] = rowsOf<{ instanceId: string }>(
    await tx.execute(sql`SELECT t.instance_id AS "instanceId" FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id = t.tenant_id AND i.id = t.instance_id
      WHERE t.tenant_id = ${tenantId} AND t.instance_id = ANY(${uuidArray(ids)}::uuid[])
        AND t.assignee_user_id = ${userId}::uuid AND t.status = 'pending'
        AND t.origin NOT IN ('self_skip', 'subject_skip')
      ORDER BY i.created_at DESC, i.id LIMIT 1`),
  );
  return row?.instanceId ?? null;
}

/** 本人最近一次办理所在实例（跨实例）。 */
async function latestHandledInstance(tx: Tx, tenantId: string, ids: readonly string[], userId: string) {
  const [row] = rowsOf<{ instanceId: string }>(
    await tx.execute(sql`SELECT l.instance_id AS "instanceId" FROM approval_instance_logs l
      JOIN approval_instances i ON i.tenant_id = l.tenant_id AND i.id = l.instance_id
      LEFT JOIN approval_handling_contents c ON c.tenant_id = l.tenant_id AND c.handling_log_id = l.id
      WHERE l.tenant_id = ${tenantId} AND l.instance_id = ANY(${uuidArray(ids)}::uuid[])
        AND l.actor_user_id = ${userId}::uuid AND l.event = ANY(${`{${HANDLING_EVENTS.join(',')}}`}::text[])
      ORDER BY COALESCE(c.acted_at, l.created_at) DESC, i.created_at DESC, i.id, l.seq DESC LIMIT 1`),
  );
  return row?.instanceId ?? null;
}

/**
 * 在同一业务对象的多个审批实例里为查看人选内容（见文件头）。instanceIds 由业务方给出（已按业务对象与租户限定）；
 * 空表示该对象还没有审批实例，一律现值。
 */
export async function selectAmong(
  tx: Tx,
  ctx: Pick<ApprovalContext, 'tenantId'>,
  instanceIds: readonly string[],
  userId: string,
  requested: string | null,
): Promise<StableRead> {
  if (requested !== null) {
    if (!instanceIds.includes(requested)) throw new AppError('NOT_FOUND', '审批实例不存在');
    return inInstance(tx, ctx, requested, userId);
  }
  if (instanceIds.length === 0) return LIVE;
  const pending = await pendingInstance(tx, ctx.tenantId, instanceIds, userId);
  if (pending) return { instanceId: pending, selection: { mode: 'live' } };
  const handled = await latestHandledInstance(tx, ctx.tenantId, instanceIds, userId);
  return handled ? inInstance(tx, ctx, handled, userId) : LIVE;
}

/** 响应里的内容来源说明（与审批中心详情的 contentView 同形）；没有选中实例（现值、无上下文）时实例为空。 */
export function contentViewOfRead(read: StableRead) {
  if (read.instanceId === null)
    return { mode: 'live' as const, instanceId: null, taskId: null, round: null, actedAt: null };
  return contentViewOf(read.instanceId, read.selection);
}
