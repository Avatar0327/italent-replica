/**
 * 发展计划的行读取（docs/02_业务建模/28 §1）：计划、阶段（子流程实例，带子流程的名称与开启规则）、当前节点。
 * 写入方先锁计划行（取锁顺序：计划 → 审批实例，与审批推进时适配器 lock 的顺序一致）。
 */
import { and, eq, idpPlans, sql, type Tx } from '@italent/db';
import type { StartRule, StageStatus } from '@italent/domain';
import { AppError } from '../../errors.js';
import { rowsOf } from './access.js';

export type PlanRow = typeof idpPlans.$inferSelect;

export async function loadPlanRow(tx: Tx, tenantId: string, id: string, lock = false): Promise<PlanRow | undefined> {
  const query = tx
    .select()
    .from(idpPlans)
    .where(and(eq(idpPlans.tenantId, tenantId), eq(idpPlans.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function requirePlanRow(tx: Tx, tenantId: string, id: string, lock = false): Promise<PlanRow> {
  const row = await loadPlanRow(tx, tenantId, id, lock);
  if (!row) throw new AppError('NOT_FOUND', '发展计划不存在');
  return row;
}

export interface StageRow extends StartRule {
  readonly id: string;
  readonly planId: string;
  readonly subProcessId: string;
  readonly seq: number;
  readonly name: string;
  readonly approvalType: string;
  readonly approvalProcessId: string;
  readonly status: StageStatus;
  readonly approvalInstanceId: string | null;
  readonly openedAt: string | null;
  readonly endedOn: string | null;
  readonly failureReason: string | null;
  readonly attemptCount: number;
  readonly lastAttemptOn: string | null;
}

interface RawStage {
  id: string;
  plan_id: string;
  sub_process_id: string;
  seq: number;
  name: string;
  approval_type: string;
  approval_process_id: string;
  status: StageStatus;
  approval_instance_id: string | null;
  opened_at: string | Date | null;
  ended_on: string | null;
  failure_reason: string | null;
  attempt_count: number;
  last_attempt_on: string | null;
  start_mode: StartRule['startMode'];
  start_time_type: StartRule['startTimeType'];
  fixed_date: string | null;
  reference_point: StartRule['referencePoint'];
  start_from: StartRule['startFrom'];
  days: number | null;
}

const stage = (r: RawStage): StageRow => ({
  id: r.id,
  planId: r.plan_id,
  subProcessId: r.sub_process_id,
  seq: Number(r.seq),
  name: r.name,
  approvalType: r.approval_type,
  approvalProcessId: r.approval_process_id,
  status: r.status,
  approvalInstanceId: r.approval_instance_id,
  openedAt: r.opened_at === null ? null : new Date(r.opened_at).toISOString(),
  endedOn: r.ended_on,
  failureReason: r.failure_reason,
  attemptCount: Number(r.attempt_count),
  lastAttemptOn: r.last_attempt_on,
  startMode: r.start_mode,
  startTimeType: r.start_time_type,
  fixedDate: r.fixed_date,
  referencePoint: r.reference_point,
  startFrom: r.start_from,
  days: r.days === null ? null : Number(r.days),
});

const STAGE_COLUMNS = sql`s.id, s.plan_id, s.sub_process_id, s.seq, sp.name, sp.approval_type, sp.approval_process_id,
  s.status, s.approval_instance_id, s.opened_at, s.ended_on::text AS ended_on, s.failure_reason, s.attempt_count,
  s.last_attempt_on::text AS last_attempt_on, sp.start_mode, sp.start_time_type, sp.fixed_date::text AS fixed_date,
  sp.reference_point, sp.start_from, sp.days`;

/** 计划的阶段（按顺序），子流程的名称与开启规则取当前配置（被引用的流程不能改顺序与开启方式，IDP-R5）。 */
export async function loadStages(tx: Tx, tenantId: string, planIds: readonly string[]): Promise<StageRow[]> {
  if (!planIds.length) return [];
  return rowsOf<RawStage>(
    await tx.execute(sql`SELECT ${STAGE_COLUMNS} FROM idp_plan_stages s
      JOIN idp_sub_processes sp ON sp.tenant_id = s.tenant_id AND sp.id = s.sub_process_id
      WHERE s.tenant_id = ${tenantId} AND s.plan_id = ANY(${`{${planIds.join(',')}}`}::uuid[])
      ORDER BY s.plan_id, s.seq`),
  ).map(stage);
}

export async function loadStage(tx: Tx, tenantId: string, stageId: string): Promise<StageRow | undefined> {
  const [row] = rowsOf<RawStage>(
    await tx.execute(sql`SELECT ${STAGE_COLUMNS} FROM idp_plan_stages s
      JOIN idp_sub_processes sp ON sp.tenant_id = s.tenant_id AND sp.id = s.sub_process_id
      WHERE s.tenant_id = ${tenantId} AND s.id = ${stageId}::uuid`),
  );
  return row ? stage(row) : undefined;
}

/** 运行中阶段的当前节点（审批实例当前节点在其冻结版本里的名称）。 */
export interface CurrentNode {
  readonly instanceId: string;
  readonly revision: number;
  readonly status: string;
  readonly nodeKey: string | null;
  readonly nodeName: string | null;
  readonly versionId: string;
}

export async function currentNodes(tx: Tx, tenantId: string, instanceIds: readonly string[]) {
  const map = new Map<string, CurrentNode>();
  if (!instanceIds.length) return map;
  const rows = rowsOf<{
    id: string;
    revision: number;
    status: string;
    current_node_key: string | null;
    name: string | null;
    version_id: string;
  }>(
    await tx.execute(sql`SELECT i.id, i.revision, i.status, i.current_node_key, n.name, i.version_id
      FROM approval_instances i
      LEFT JOIN approval_process_nodes n ON n.tenant_id = i.tenant_id AND n.version_id = i.version_id
        AND n.node_key = i.current_node_key
      WHERE i.tenant_id = ${tenantId} AND i.id = ANY(${`{${instanceIds.join(',')}}`}::uuid[])`),
  );
  for (const r of rows) {
    map.set(r.id, {
      instanceId: r.id,
      revision: Number(r.revision),
      status: r.status,
      nodeKey: r.current_node_key,
      nodeName: r.name,
      versionId: r.version_id,
    });
  }
  return map;
}

/** 某人在实例里的在办任务所在节点（没有为 null）。 */
export async function pendingNodeOf(tx: Tx, tenantId: string, instanceId: string, userId: string) {
  const [row] = rowsOf<{ node_key: string }>(
    await tx.execute(sql`SELECT node_key FROM approval_tasks WHERE tenant_id = ${tenantId}
      AND instance_id = ${instanceId}::uuid AND status = 'pending' AND assignee_user_id = ${userId}::uuid
      ORDER BY seq LIMIT 1`),
  );
  return row?.node_key ?? null;
}

/** 计划修订号 + 1（计划的组成部分写入都推进计划的 revision，并发控制用它）。 */
export async function bumpPlan(tx: Tx, tenantId: string, planId: string, now: Date): Promise<void> {
  await tx.execute(sql`UPDATE idp_plans SET revision = revision + 1, updated_at = ${now.toISOString()}
    WHERE tenant_id = ${tenantId} AND id = ${planId}::uuid`);
}
