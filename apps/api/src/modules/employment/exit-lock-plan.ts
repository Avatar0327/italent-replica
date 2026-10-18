/**
 * 离职创建入口的参与员工闭包（R2-T03 §5.2 ①，P2-2）：离职员工 + 职责转交下属（本批新开放）+ 既有联动闭包
 * （lockTransferParticipants 内部再按已登记的转交 / 新增下属展开）。单人入口（createExitApplication）与批量入口（createExitBatch）
 * 共用这一处：在首次员工锁之前、组织锁之前，一次按全局 UUID 升序取齐并登记，之后各人提交复用这份锁计划，
 * 不会出现“处理到后面的人才发现更小的参与人”（TRANSFER_LOCK_PLAN_CHANGED）。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import { normalizeLinkage, dutySubordinateIds } from '../transfer/linkage/input.js';
import { lockTransferParticipants } from './transfer-locks.js';
import { rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';

export interface ExitLockEntry {
  readonly employeeId: string;
  /** 请求里的 exit.dutyTransfer 原值；结构非法在这里忽略（由逐人校验给出 400），闭包只取能解析的下属。 */
  readonly dutyTransfer?: unknown;
}

/** 单条请求的转交下属 ID；结构非法返回空。 */
export function exitDutySubordinates(dutyTransfer: unknown): string[] {
  if (dutyTransfer === undefined) return [];
  try {
    return dutySubordinateIds(normalizeLinkage({ dutyTransfer }));
  } catch {
    return [];
  }
}

const idArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

/**
 * 锁整批闭包。离职员工必须存在且可锁（调用方对批量里不存在的员工另行报原因，传入前已剔除）；转交下属不存在时忽略——
 * 逐人校验（validateLinkage）会以同一机读原因拒绝，不让整批在这里整体失败。
 */
export async function lockExitParticipants(tx: Tx, ctx: EmploymentContext, entries: readonly ExitLockEntry[]) {
  if (!entries.length) return;
  const employees = [...new Set(entries.map((entry) => entry.employeeId.toLowerCase()))];
  const wanted = [...new Set(entries.flatMap((entry) => exitDutySubordinates(entry.dutyTransfer)))].filter(
    (id) => !employees.includes(id) && isUuid(id),
  );
  const existing = wanted.length
    ? rowsOf<{ id: string }>(
        await tx.execute(sql`SELECT id::text AS id FROM employment_employees
          WHERE tenant_id=${ctx.tenantId} AND id=ANY(${idArray(wanted)})`),
      ).map((row) => row.id)
    : [];
  await lockTransferParticipants(tx, ctx, employees[0]!, [...employees.slice(1), ...existing]);
}
