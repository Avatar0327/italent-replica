/**
 * 离职占用投影的取数（R2-T03 设计 §6B.1，B3-3）：组织停用计数（O，org-people.ts）与编制占用（P，establishment/employment-check.ts）
 * 读同一份离职状态，是否扣减由 domain `exitOccupancy` 判定，SQL 只负责取数。只认有扩展行（走过离职门禁）的离职：
 * approved（含生效失败仍为 approved 的单）与 effective，撤销 / 作废 / 删除的离职最新状态不在其中，自然不参与。
 */
import { sql, type Tx } from '@italent/db';
import type { ExitState } from '@italent/domain';
import { rowsOf } from './record-store.js';
import { plannedEffectiveDate } from './timeline.js';

const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * 员工名下 approved / effective 的离职。effectiveDate：approved 为 §5.0A 计划生效日 E（D-16），effective 为落地后的 E′（最新载荷日）；
 * 释放时点 R 缺失（未进入 confirmed，正常不会出现）时取 E，避免误判为从更早起释放。
 */
export async function loadExitStates(
  tx: Tx,
  tenantId: string,
  employeeIds: readonly string[],
  states: readonly ('approved' | 'effective')[] = ['approved', 'effective'],
): Promise<ExitState[]> {
  if (!employeeIds.length) return [];
  const planned = plannedEffectiveDate(tenantId, sql`b.id`, sql`p.effective_date`);
  const rows = rowsOf<Omit<ExitState, 'releaseDate'> & { releaseDate: string | null; plannedDate: string }>(
    await tx.execute(sql`
    SELECT b.id AS "businessId", b.employee_id::text AS "employeeId", x.staff_id::text AS "staffId", s.state,
      p.effective_date::text AS "effectiveDate", ${planned}::text AS "plannedDate",
      x.pre_release_date::text AS "releaseDate",
      (SELECT min(c.entry_date)::text FROM employment_cycles c
        WHERE c.tenant_id=b.tenant_id AND c.employee_id=b.employee_id
          AND c.entry_date > COALESCE(x.pre_release_date, ${planned})) AS "nextCycleEntryDate"
    FROM exit_requests x
    JOIN employment_business_objects b ON b.tenant_id=x.tenant_id AND b.id=x.business_id
    JOIN LATERAL (SELECT effective_date FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s
      WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id ORDER BY s.event_no DESC LIMIT 1) s ON true
    WHERE x.tenant_id=${tenantId} AND x.employee_id = ANY(${uuidArray(employeeIds)})
      AND s.state = ANY(${`{${states.join(',')}}`}::text[])
    ORDER BY b.id`),
  );
  return rows.map(({ plannedDate, ...row }) => ({
    ...row,
    effectiveDate: row.state === 'approved' ? plannedDate : row.effectiveDate,
    releaseDate: row.releaseDate ?? plannedDate,
  }));
}

/** 员工各任职周期的入职日（升序），按日期把区间归到所属周期：取入职日 ≤ 该日的最后一个周期。 */
export async function loadCycleStarts(tx: Tx, tenantId: string, employeeIds: readonly string[]) {
  const rows = rowsOf<{ employeeId: string; staffId: string; entryDate: string }>(
    await tx.execute(sql`SELECT employee_id::text AS "employeeId", id::text AS "staffId",
        entry_date::text AS "entryDate"
      FROM employment_cycles WHERE tenant_id=${tenantId} AND employee_id = ANY(${uuidArray(employeeIds)})
      ORDER BY employee_id, entry_date`),
  );
  const byEmployee = new Map<string, { staffId: string; entryDate: string }[]>();
  for (const row of rows) byEmployee.set(row.employeeId, [...(byEmployee.get(row.employeeId) ?? []), row]);
  return (employeeId: string, date: string): string => {
    const cycles = byEmployee.get(employeeId) ?? [];
    return (cycles.filter((cycle) => cycle.entryDate <= date).at(-1) ?? cycles[0])?.staffId ?? '';
  };
}

/** 员工在某日所属的任职周期（入职日 ≤ 该日的最后一个周期）；没有则空。 */
export async function cycleOn(tx: Tx, tenantId: string, employeeId: string, date: string): Promise<string | undefined> {
  const [row] = rowsOf<{ staffId: string }>(
    await tx.execute(sql`SELECT id::text AS "staffId" FROM employment_cycles
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND entry_date <= ${date}::date
      ORDER BY entry_date DESC LIMIT 1`),
  );
  return row?.staffId;
}
