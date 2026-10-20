/**
 * 兼职联动的参与者规划（docs/08_设计/R2-T05_兼职设计.md §4.8 / §7.1）：员工闭包取锁（transfer-locks.ts participants）在取任何员工锁
 * 之前，把这些员工名下“还会改别人的”兼职联动并入闭包——否则落地 / 执行时才发现下属、又不是按 UUID 升序，会撞逆序保护（409
 * TRANSFER_LOCK_PLAN_CHANGED，刷新重提也过不去）。两类来源，所有取闭包的入口（立即落地、编辑、到期调度、审批同意 / 批量交接 /
 * 停用接管）都经 lockTransferParticipants 走同一条规划，不各自补锁：
 * - 未办结的待执行联动：兼职记录最新载荷里的新增下属（开始日到了由定时生效执行）；
 * - 审批中的新增兼职申请：最新版本里的新增下属（同意落地时执行，交接 / 接管合席也会触发落地）。
 * 只读、不加锁；独立成文件是为了让 transfer-locks.ts 引用而不与 linkage.ts（引用 transfer-locks）成环。
 */
import { sql, type Tx } from '@italent/db';
import { PART_TIME_LINKAGE_EVENTS as EVENTS } from '@italent/domain';
import { rowsOf } from '../record-store.js';

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * 升级前的库（迁移停在兼职申请版本表的联动列之前，升级演练用例）还没有这一列：查到有表之后记住，不每次闭包规划都多一次往返。
 * 缓存按进程；生产库迁移完整，第一次查询之后恒为真。
 */
let requestsReady = false;
async function hasRequestTables(tx: Tx): Promise<boolean> {
  if (requestsReady) return true;
  const [row] = rowsOf<{ ready: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name='part_time_request_versions'
        AND column_name='added_subordinate_ids') AS ready`),
  );
  requestsReady = row?.ready === true;
  return requestsReady;
}

/** 这些员工名下兼职联动涉及的下属（去重前的原始数组列表，空值已滤掉）。 */
export async function partTimeLinkageParticipants(
  tx: Tx,
  tenantId: string,
  employeeIds: readonly string[],
): Promise<string[][]> {
  const pending = rowsOf<{ ids: string[] | null }>(
    await tx.execute(sql`
      SELECT p.added_subordinate_ids AS ids FROM employment_outbox o
      JOIN LATERAL (SELECT added_subordinate_ids FROM employment_payload_versions p
        WHERE p.tenant_id=o.tenant_id AND p.business_id=o.business_id ORDER BY version_no DESC LIMIT 1) p ON true
      WHERE o.tenant_id=${tenantId} AND o.employee_id=ANY(${uuidArray(employeeIds)})
        AND o.event_type=${EVENTS.pending} AND p.added_subordinate_ids IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM employment_outbox d WHERE d.tenant_id=o.tenant_id AND d.business_id=o.business_id
          AND d.event_type IN (${EVENTS.linked}, ${EVENTS.skipped}))`),
  );
  const requests = rowsOf<{ ids: string[] | null }>(
    !(await hasRequestTables(tx))
      ? []
      : await tx.execute(sql`
      SELECT v.added_subordinate_ids AS ids FROM part_time_requests q
      JOIN LATERAL (SELECT state FROM part_time_request_events e
        WHERE e.tenant_id=q.tenant_id AND e.request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT added_subordinate_ids FROM part_time_request_versions v
        WHERE v.tenant_id=q.tenant_id AND v.request_id=q.id ORDER BY version_no DESC LIMIT 1) v ON true
      WHERE q.tenant_id=${tenantId} AND q.employee_id=ANY(${uuidArray(employeeIds)}) AND q.request_type='add'
        AND s.state='in_review' AND v.added_subordinate_ids IS NOT NULL`),
  );
  return [...pending, ...requests].flatMap((row) => (row.ids ? [row.ids] : []));
}
