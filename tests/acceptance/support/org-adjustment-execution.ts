/**
 * BE-11a 组织调整执行底座的测试造数：申请单头 / 明细 / 暂停行 / 审批实例直接落库（公开创建与审批入口随 BE-10c 接入），
 * 执行走内部执行器入口；读写一律放进对应租户的 withTenant（F-212，app_owner 下可过）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import type {
  ExecutionGroup,
  GroupExecutor,
  GroupExecutors,
} from '../../../apps/api/src/modules/org-adjustment/execution-groups.js';
import { installApprovalFallbacks } from '../AC-APV-support.js';
import { resultRows } from '../AC-ORG-people-support.js';
import { uniqueSuffix } from './unique.js';

export interface SeededAdjustment {
  readonly id: string;
  readonly code: string;
}

/** 已审批通过（approval_status=2）、未执行的申请单头。 */
export async function seedAdjustment(
  db: Db,
  tenantId: string,
  input: { createdBy: string; subjectOrgId: string; effectiveDate: string; approvedAt?: string },
): Promise<SeededAdjustment> {
  const row = { id: randomUUID(), code: `OA${uniqueSuffix()}` };
  const approvedAt = input.approvedAt ?? '2026-09-30T00:00:00.000Z';
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO org_adjustments(id, tenant_id, code, subject, effective_date,
        approval_subject_org_id, created_by, approval_status, approved_at)
      VALUES (${row.id}, ${tenantId}, ${row.code}, '合成调整', ${input.effectiveDate},
        ${input.subjectOrgId}, ${input.createdBy}, 2, ${approvedAt})`),
  );
  return row;
}

/** 明细行：缺省为“变更”（adjust_type=2），列名同表结构（snake_case）。 */
export async function seedItem(
  db: Db,
  tenantId: string,
  adjustmentId: string,
  over: Record<string, unknown>,
): Promise<string> {
  const row: Record<string, unknown> = { id: randomUUID(), adjustment_id: adjustmentId, adjust_type: 2, ...over };
  row.name ??= `明细${uniqueSuffix()}`;
  const columns = Object.keys(row);
  const values = sql.join(
    columns.map((c) => sql`${row[c]}`),
    sql`, `,
  );
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO org_adjustment_org_items(tenant_id, ${sql.raw(columns.join(', '))})
      VALUES (${tenantId}, ${values})`),
  );
  return row.id as string;
}

/** 直接写暂停行（模拟执行开始事务已落暂停）。 */
export async function pauseOrgs(db: Db, tenantId: string, adjustmentId: string, orgIds: readonly string[]) {
  await withTenant(db, tenantId, async (tx) => {
    for (const orgId of orgIds)
      await tx.execute(sql`INSERT INTO org_adjustment_pauses(tenant_id, org_id, adjustment_id)
        VALUES (${tenantId}, ${orgId}, ${adjustmentId})`);
  });
}

/** 已通过的审批实例（装 org_adjustment 兜底流程后取其已发布版本）：收尾站内消息挂在它上面。 */
export async function seedApprovalInstance(db: Db, tenantId: string, adjustmentId: string, userId: string) {
  await installApprovalFallbacks(db, tenantId, userId, ['org_adjustment']);
  await withTenant(db, tenantId, (tx) =>
    tx.execute(sql`INSERT INTO approval_instances
        (tenant_id, process_id, version_id, approval_type, object_code, business_type, business_id,
          initiator_user_id, title, status, business_version)
      SELECT ${tenantId}, p.id, v.id, 'org_adjustment', 'TenantBase.OrganizationApproval', 'org_adjustment',
        ${adjustmentId}, ${userId}, '合成组织调整', 'approved', 'revision:1'
      FROM approval_processes p JOIN approval_process_versions v ON v.process_id=p.id AND v.tenant_id=p.tenant_id
      WHERE p.tenant_id=${tenantId} AND p.approval_type='org_adjustment' AND v.status='published' LIMIT 1`),
  );
}

export interface AdjustmentState {
  readonly execution_status: number;
  readonly revision: number;
  readonly data_volume: number | null;
  readonly success_count: number | null;
  readonly failure_count: number | null;
  readonly execution_note: string | null;
  readonly executed_at: string | null;
  readonly state: string | null;
  readonly run_on_date: string | null;
  readonly run_from_hour: number | null;
}

export async function adjustmentState(db: Db, tenantId: string, id: string): Promise<AdjustmentState> {
  return withTenant(db, tenantId, async (tx) => {
    const [row] = resultRows<AdjustmentState>(
      await tx.execute(sql`SELECT a.execution_status, a.revision, a.data_volume, a.success_count, a.failure_count,
          a.execution_note, a.executed_at::text, x.state, x.run_on_date::text, x.run_from_hour
        FROM org_adjustments a
        LEFT JOIN org_adjustment_executions x ON x.tenant_id=a.tenant_id AND x.adjustment_id=a.id
        WHERE a.tenant_id=${tenantId} AND a.id=${id}`),
    );
    return row!;
  });
}

export interface ItemResult {
  readonly id: string;
  readonly execution_result: number | null;
  readonly exec_phase: number;
  readonly execution_reason: string | null;
}

export async function itemResults(db: Db, tenantId: string, adjustmentId: string): Promise<Map<string, ItemResult>> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = resultRows<ItemResult>(
      await tx.execute(sql`SELECT id, execution_result, exec_phase, execution_reason FROM org_adjustment_org_items
        WHERE tenant_id=${tenantId} AND adjustment_id=${adjustmentId}`),
    );
    return new Map(rows.map((row) => [row.id, row]));
  });
}

export async function tableRows<T>(db: Db, tenantId: string, table: string, adjustmentId: string): Promise<T[]> {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<T>(
      await tx.execute(sql`SELECT * FROM ${sql.raw(table)}
        WHERE tenant_id=${tenantId} AND adjustment_id=${adjustmentId}`),
    ),
  );
}

export async function executionAudits(db: Db, tenantId: string, adjustmentId: string) {
  return withTenant(db, tenantId, async (tx) =>
    resultRows<{ action: string; actor_user_id: string | null; after: Record<string, unknown> }>(
      await tx.execute(sql`SELECT action, actor_user_id, after FROM audit_events
        WHERE tenant_id=${tenantId} AND object_id=${adjustmentId} AND action LIKE 'org-adjustment.execution.%'
        ORDER BY occurred_at, id`),
    ),
  );
}

/** 测试用假执行器：按调整类型记录调用顺序；behavior 可按组注入失败。 */
export function fakeExecutors(behavior: (group: ExecutionGroup) => Promise<void> | void = () => undefined) {
  const calls: string[] = [];
  const executor: GroupExecutor = async (_tx, { group }) => {
    calls.push(group.id);
    await behavior(group);
    return 'done';
  };
  const executors: GroupExecutors = { 1: executor, 2: executor, 3: executor };
  return { calls, executors };
}
