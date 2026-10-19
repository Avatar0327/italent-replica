/**
 * 离职 / 退休结束兼职（docs/08_设计/R2-T05_兼职设计.md §4.6，AC-PT-09 结束）：任职状态钩子订阅方 `part-time`，只实现
 * onRecordMaterialized。在离职落地的同一事务里（员工行已被调用方锁住），把该任职周期的每条兼职结束于 L′ = 离职实际生效日 − 1：
 * 当前结束日为空或晚于 L′ 的追加期限，开始日晚于 L′ 的写空区间（end = start − 1）；source = exit、source_id = 离职记录。
 * 原站对“离职对兼职”的结果未验证（B-4 / A-3），复刻取最保守：员工不在职就不能有进行中的兼职。
 * 撤销（删除）离职不自动恢复，HR 用编辑兼职改结束日恢复（A-4）。同一事务里还作废该员工全部未办结（草稿 / 审批中 / 驳回）的
 * 兼职申请（reason = exit）：实例走 approval/actions cancel 关闭待办，站内消息走 notifyMessage，没有实例的草稿只留 outbox
 * （R2f2 B63，PT-4a；做法同 employment/exit-void-applications.ts）。订阅方只在存储错误时抛。
 * 锁序（§4.6）：员工行（调用方已持有）→ 兼职记录头按 ID 升序 → 申请头按 ID 升序 → 审批实例按 ID 升序。
 */
import {
  PART_TIME_AUDIT_OBJECTS,
  PART_TIME_NOTICE_TEMPLATES,
  PART_TIME_TERMINATION_KINDS,
  partTimeCutoffEnd,
  partTimeExitEndDate,
} from '@italent/domain';
import { sql, type Tx } from '@italent/db';
import { auditEmployment } from '../context.js';
import { rowsOf } from '../record-store.js';
import type { EmployeeStatusHookContext, EmployeeStatusHooks, EmploymentRecordEvent } from '../status-hooks.js';
import type { EmploymentContext } from '../types.js';
import { lockOpenInstances, lockOpenRequests } from './request-store.js';
import { voidPartTimeRequest } from './request-service.js';
import { appendPartTimeTerm, lockPartTimeRecords } from './store.js';

async function endPartTimesByExit(tx: Tx, hook: EmployeeStatusHookContext, event: EmploymentRecordEvent) {
  const [exit] = rowsOf<{ staffId: string }>(
    await tx.execute(sql`SELECT staff_id AS "staffId" FROM employment_records
      WHERE tenant_id=${hook.tenantId} AND employee_id=${event.employeeId}::uuid AND id=${event.recordId}::uuid`),
  );
  if (!exit) return;
  const ctx: EmploymentContext = { ...hook, expectedRevision: 0 };
  const lastDay = partTimeExitEndDate(event.effectiveDate);
  for (const record of await lockPartTimeRecords(tx, ctx, event.employeeId, { staffId: exit.staffId })) {
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

async function voidRequestsByExit(tx: Tx, hook: EmployeeStatusHookContext, event: EmploymentRecordEvent) {
  const ctx: EmploymentContext = { ...hook, expectedRevision: 0 };
  const requests = await lockOpenRequests(tx, ctx, event.employeeId);
  await lockOpenInstances(tx, ctx, requests);
  for (const request of requests)
    await voidPartTimeRequest(tx, ctx, request, {
      reason: 'exit',
      action: 'part_time.request.voided_by_exit',
      template: PART_TIME_NOTICE_TEMPLATES.voidedByExit,
    });
}

/** 模块级单例：同名同实例重复登记幂等（status-hooks.ts 既有规则），createApp 多次调用安全（§4.9）。 */
export const PART_TIME_EXIT_HOOKS: EmployeeStatusHooks = {
  async onRecordMaterialized(tx, ctx, event) {
    if (!PART_TIME_TERMINATION_KINDS.includes(event.kind)) return;
    await endPartTimesByExit(tx, ctx, event);
    await voidRequestsByExit(tx, ctx, event);
  },
};
