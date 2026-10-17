/**
 * 离职 / 退休结束兼职（docs/08_设计/R2-T05_兼职设计.md §4.6，AC-PT-09 结束）：任职状态钩子订阅方 `part-time`，只实现
 * onRecordMaterialized。在离职落地的同一事务里（员工行已被调用方锁住），把该任职周期的每条兼职结束于 L′ = 离职实际生效日 − 1：
 * 当前结束日为空或晚于 L′ 的追加期限，开始日晚于 L′ 的写空区间（end = start − 1）；source = exit、source_id = 离职记录。
 * 原站对“离职对兼职”的结果未验证（B-4 / A-3），复刻取最保守：员工不在职就不能有进行中的兼职。
 * 撤销（删除）离职不自动恢复，HR 用编辑兼职改结束日恢复（A-4）；申请的作废随 PT-4a。订阅方只在存储错误时抛。
 */
import {
  PART_TIME_AUDIT_OBJECTS,
  PART_TIME_TERMINATION_KINDS,
  partTimeCutoffEnd,
  partTimeExitEndDate,
} from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import { auditEmployment } from '../context.js';
import { rowsOf } from '../record-store.js';
import type { EmployeeStatusHookContext, EmployeeStatusHooks, EmploymentRecordEvent } from '../status-hooks.js';
import type { EmploymentContext } from '../types.js';
import { appendPartTimeTerm, lockPartTimeRecords } from './store.js';

async function endPartTimesByExit(tx: Tx, hook: EmployeeStatusHookContext, event: EmploymentRecordEvent) {
  const [exit] = rowsOf<{ staffId: string }>(
    await tx.execute(sql`SELECT staff_id AS "staffId" FROM employment_records
      WHERE tenant_id=${hook.tenantId} AND employee_id=${event.employeeId}::uuid AND id=${event.recordId}::uuid`),
  );
  if (!exit) return;
  const ctx: EmploymentContext = { ...hook, expectedRevision: 0 };
  const lastDay = partTimeExitEndDate(event.effectiveDate);
  for (const record of await lockPartTimeRecords(tx, ctx, event.employeeId, exit.staffId)) {
    const endDate = partTimeCutoffEnd(record, lastDay);
    if (endDate === null) continue;
    const next = await appendPartTimeTerm(tx, ctx, record, { endDate, source: 'exit', sourceId: event.recordId });
    await auditEmployment(
      tx,
      ctx,
      'employment.part_time.ended_by_exit',
      PART_TIME_AUDIT_OBJECTS.record,
      record.id,
      { endDate: record.endDate },
      { endDate, termNo: next.termNo },
      undefined,
      { exitRecordId: event.recordId },
      { employeeId: record.employeeId, orgId: record.departmentId },
    );
  }
}

/** 模块级单例：同名同实例重复登记幂等（status-hooks.ts 既有规则），createApp 多次调用安全（§4.9）。 */
export const PART_TIME_EXIT_HOOKS: EmployeeStatusHooks = {
  async onRecordMaterialized(tx, ctx, event) {
    if (!PART_TIME_TERMINATION_KINDS.includes(event.kind)) return;
    await endPartTimesByExit(tx, ctx, event);
  },
};
