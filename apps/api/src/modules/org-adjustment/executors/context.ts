/**
 * R2-T08 §8.1 组织明细执行器的共用部分：组内明细（含执行列）重读、系统身份的组织写上下文、§6.3 基线复核与执行列回写。
 * 全部在运行器的 fenced 组事务内调用；明细在本事务重读，不信任领组时的快照（F-341）。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import { SYSTEM_USER_ID } from '../../../system-actor.js';
import { rowsOf } from '../../approval/context.js';
import { loadOrgSnapshot, type OrgRecord } from '../../org/read-model.js';
import type { OrgWriteContext } from '../../org/write-service.js';
import type { GroupInput } from '../execution-groups.js';
import { BASELINE_CHANGED } from '../item-check.js';
import { loadItems, type OrgItem } from '../items-store.js';

export interface ExecutionColumns {
  readonly execPhase: number;
  readonly createdOrgId: string | null;
  readonly executedVersionId: string | null;
  readonly employmentCursor: string | null;
  readonly employmentDone: number;
  readonly employmentFailed: number;
}

export type ExecItem = OrgItem & ExecutionColumns;

async function executionColumns(tx: Tx, input: GroupInput) {
  const rows = rowsOf<ExecutionColumns & { id: string }>(
    await tx.execute(sql`SELECT id, exec_phase AS "execPhase", created_org_id AS "createdOrgId",
        executed_version_id AS "executedVersionId", employment_cursor AS "employmentCursor",
        employment_done AS "employmentDone", employment_failed AS "employmentFailed"
      FROM org_adjustment_org_items WHERE tenant_id=${input.tenantId} AND adjustment_id=${input.adjustment.id}::uuid`),
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/** 本组各行（组首在前）的完整内容与执行列。 */
export async function groupItems(tx: Tx, input: GroupInput): Promise<ExecItem[]> {
  const ids = new Set(input.group.items.map((item) => item.id));
  const columns = await executionColumns(tx, input);
  const items = (await loadItems(tx, input.tenantId, input.adjustment.id)).filter((item) => ids.has(item.id));
  items.sort((a, b) => Number(b.id === input.group.id) - Number(a.id === input.group.id) || a.seq - b.seq);
  return items.map((item) => ({ ...item, ...columns.get(item.id)! }));
}

/** §2.6：同单新增行引用的正式组织 ID；被引用行尚未建成时为 null（运行器已按 DEPENDENCY_FAILED 拦截）。 */
export async function createdOrgOf(tx: Tx, input: GroupInput, itemId: string | null) {
  if (!itemId) return null;
  return (await executionColumns(tx, input)).get(itemId)?.createdOrgId ?? null;
}

/** 新上级：既有组织直接用；引用同单新增行时解析为其正式 ID。 */
export async function parentOf(tx: Tx, input: GroupInput, item: OrgItem) {
  return item.parentOrgId ?? (await createdOrgOf(tx, input, item.parentItemId));
}

/** 执行身份为系统用户；带本单 ID，本单暂停行不拦本单写入（§7.6）。expectedRevision 取对象当前值。 */
export async function orgWriteContext(tx: Tx, input: GroupInput, orgId?: string): Promise<OrgWriteContext> {
  const { tenantId } = input;
  const [root] = rowsOf<{ name: string }>(
    await tx.execute(sql`SELECT name FROM org_versions WHERE tenant_id=${tenantId} AND org_id=${tenantId}::uuid
      ORDER BY version_no DESC LIMIT 1`),
  );
  if (!root) throw new AppError('SERVICE_UNAVAILABLE', '组织根尚未初始化');
  return {
    tenantId,
    userId: SYSTEM_USER_ID,
    timezone: input.timezone,
    rootName: root.name,
    now: input.now,
    commandId: input.commandId,
    expectedRevision: orgId ? ((await liveOrg(tx, input, orgId))?.revision ?? 0) : 0,
    orgAdjustmentId: input.adjustment.id,
  };
}

/** 目标组织在生效日的现行版本（含停用）；不存在时 undefined。 */
export async function liveOrg(tx: Tx, input: GroupInput, orgId: string): Promise<OrgRecord | undefined> {
  const filter = { id: orgId, includeDisabled: true };
  const [record] = await loadOrgSnapshot(tx, input.tenantId, input.adjustment.effectiveDate, undefined, filter);
  return record;
}

/** §6.3 / §2.5：有基线的行（含连带行），生效日现行版本或 revision 与审批时不同 → 本组失败，不覆盖外部修改。 */
export async function assertBaseline(tx: Tx, input: GroupInput, items: readonly ExecItem[]) {
  for (const item of items) {
    if (!item.targetOrgId || !item.baseVersionId) continue;
    const live = await liveOrg(tx, input, item.targetOrgId);
    if (live && live.versionId === item.baseVersionId && live.revision === item.baseOrgRevision) continue;
    throw new AppError('CONFLICT', '组织在审批后已被修改，本行未执行', { reason: BASELINE_CHANGED });
  }
}

/** 回写执行列：只写给出的列。 */
export async function markItem(
  tx: Tx,
  input: GroupInput,
  itemId: string,
  set: { executedVersionId?: string; createdOrgId?: string; execPhase?: 1 },
) {
  await tx.execute(sql`UPDATE org_adjustment_org_items SET
      executed_version_id=coalesce(${set.executedVersionId ?? null}::uuid, executed_version_id),
      created_org_id=coalesce(${set.createdOrgId ?? null}::uuid, created_org_id),
      exec_phase=coalesce(${set.execPhase ?? null}::smallint, exec_phase)
    WHERE tenant_id=${input.tenantId} AND id=${itemId}::uuid`);
}
