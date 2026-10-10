/**
 * 同步行在资格时间轴上的落位（R3-T02 C1-4 第 2 轮；DEC-407：统一时间轴、同日按登记先后、HR 删除后不补回；DEC-335①）。
 * 每人的任职资格是一条不重叠的单一时间轴，自动同步与手工录入混排：
 * - 新同步行的 endDate 止于时间轴上下一条开始日的前一天（没有下一条则开放）；
 * - 此前仍覆盖新开始日的最近一行（开放或结束日不早于新开始日）收尾到新开始日前一天，只改 endDate，不改来源，留版本和审计；
 * - 同一天的多笔同步事件按**任职事件登记先后**（outbox 事件的创建时间、事件 ID）定序，不按消费 / 重试时刻：
 *   已有更晚登记的同日同步行 → 本条被取代，不生成；已有更早登记的同日同步行 → 被本条取代，软删（留版本，足迹不丢）。
 *   同日的手工行不动（它与同步行的先后没有口径，🟡）。
 * 全部在员工锁与人员锁之内读写，调用方负责先取锁。
 */
import { sql, type Tx } from '@italent/db';
import { rowsOf } from '../employment/record-store.js';

export interface TimelineRef {
  readonly id: string;
  readonly revision: number;
  readonly employmentRecordId: string | null;
}

export type TimelinePlacement =
  | { readonly kind: 'superseded' }
  | {
      readonly kind: 'write';
      /** 新行的结束日：下一条开始日前一天，没有下一条则 null。 */
      readonly endDate: string | null;
      /** 被本条取代、需要软删的更早登记的同日同步行。 */
      readonly supersede: readonly TimelineRef[];
      /** 需要收尾到新开始日前一天的前一行。 */
      readonly closeId: string | null;
    };

export async function planTimeline(
  tx: Tx,
  at: { tenantId: string; employeeId: string; startDate: string; recordId: string; outboxId: string },
): Promise<TimelinePlacement> {
  const { tenantId, employeeId, startDate } = at;
  const sameDay = rowsOf<TimelineRef & { later: boolean }>(
    await tx.execute(sql`SELECT p.id, p.revision::int AS revision, p.employment_record_id AS "employmentRecordId",
        ((reg.created_at, reg.id) > (me.created_at, me.id)) AS later
      FROM personnel_qualification p
      CROSS JOIN (SELECT created_at, id FROM employment_outbox
        WHERE tenant_id=${tenantId} AND id=${at.outboxId}::uuid) me
      CROSS JOIN LATERAL (SELECT e.created_at, e.id FROM employment_outbox e
        WHERE e.tenant_id=p.tenant_id AND e.object_id=p.employment_record_id AND e.event_type='employment.record.create'
        ORDER BY e.created_at, e.id LIMIT 1) reg
      WHERE p.tenant_id=${tenantId} AND p.employee_id=${employeeId}::uuid AND NOT p.deleted
        AND p.start_date=${startDate}::date AND p.source_type='employment_sync'
        AND p.employment_record_id<>${at.recordId}::uuid`),
  );
  if (sameDay.some((row) => row.later)) return { kind: 'superseded' };
  const [next] = rowsOf<{ endDate: string | null }>(
    await tx.execute(sql`SELECT (min(start_date) - 1)::text AS "endDate" FROM personnel_qualification
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND NOT deleted
        AND start_date > ${startDate}::date`),
  );
  const [previous] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM personnel_qualification
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND NOT deleted
        AND start_date < ${startDate}::date AND (end_date IS NULL OR end_date >= ${startDate}::date)
      ORDER BY start_date DESC, created_at DESC, id DESC LIMIT 1`),
  );
  return {
    kind: 'write',
    endDate: next?.endDate ?? null,
    supersede: sameDay.map(({ id, revision, employmentRecordId }) => ({ id, revision, employmentRecordId })),
    closeId: previous?.id ?? null,
  };
}

/** 该任职记录已同步过：看不可变的子集版本（首个版本的来源是 employment_sync），HR 之后编辑 / 删除都改写不了它。 */
export async function hasSyncFootprint(tx: Tx, tenantId: string, recordId: string): Promise<boolean> {
  const [found] = rowsOf<{ n: number }>(
    await tx.execute(sql`SELECT 1 AS n FROM personnel_qualification_versions
      WHERE tenant_id=${tenantId} AND employment_record_id=${recordId}::uuid
        AND source_type='employment_sync' LIMIT 1`),
  );
  return Boolean(found);
}
