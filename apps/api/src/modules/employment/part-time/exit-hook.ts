/**
 * 离职 / 退休结束兼职（docs/08_设计/R2-T05_兼职设计.md §4.6，AC-PT-09 结束）：任职状态钩子订阅方 `part-time`，只实现
 * onRecordMaterialized。在离职落地的同一事务里（员工行已被调用方锁住），把该任职周期的每条兼职结束于 L′ = 离职实际生效日 − 1：
 * 当前结束日为空或晚于 L′ 的追加期限，开始日晚于 L′ 的写空区间（end = start − 1）；source = exit、source_id = 离职记录。
 * 原站对“离职对兼职”的结果未验证（B-4 / A-3），复刻取最保守：员工不在职就不能有进行中的兼职。
 * 撤销（删除）离职不自动恢复，HR 用编辑兼职改结束日恢复（A-4）。同一事务里还作废该员工全部未办结（草稿 / 审批中 / 驳回）的
 * 兼职申请（reason = exit）：实例走 approval/actions cancel 关闭待办，站内消息走 notifyMessage，没有实例的草稿只留 outbox
 * （R2f2 B63，PT-4a；做法同 employment/exit-void-applications.ts）。订阅方只在存储错误时抛。
 * DEC-725：离职按“离职生效时终止在途流程”配置作废——新增 / 延长 / 结束兼职勾选的全部作废，未勾选的只作废日期晚于 L′ 的
 * （新增取开始日，延长 / 结束取结束日，空视为晚于）；退休暂不接配置（F-351），全部作废。
 * 结束的兼职与作废的申请同事务写 exit_effects（part_time_ended / part_time_request_voided，F-429），与任职 / 合同台账同结构；
 * 撤销清单仍由 part-time 探针（exit-cancel-probe.ts）按期限链 / 申请事件列出，这两类台账不进撤销清单，避免重复列出。
 * 锁序（§4.6）：员工行（调用方已持有）→ 兼职记录头按 ID 升序 → 申请头按 ID 升序 → 审批实例按 ID 升序。
 */
import {
  type ExitTerminationSetting,
  PART_TIME_AUDIT_OBJECTS,
  PART_TIME_NOTICE_TEMPLATES,
  PART_TIME_TERMINATION_KINDS,
  partTimeCutoffEnd,
  partTimeExitEndDate,
  partTimeRequestFlow,
} from '@italent/domain';
import { exitEffects, sql, type Tx } from '@italent/db';
import { auditEmployment } from '../context.js';
import { exitTerminationOf, terminates } from '../exit-termination-policy.js';
import { rowsOf } from '../record-store.js';
import type { EmployeeStatusHookContext, EmployeeStatusHooks, EmploymentRecordEvent } from '../status-hooks.js';
import type { EmploymentContext } from '../types.js';
import { lockOpenInstances, lockOpenRequests, type PartTimeRequestRow } from './request-store.js';
import { voidPartTimeRequest } from './request-service.js';
import { appendPartTimeTerm, lockPartTimeRecords } from './store.js';

/** 台账行：业务 = 离职单（任职记录与离职业务同一 ID），phase = effective，随状态钩子的事务一起提交 / 回滚。 */
const effectRow = (
  hook: EmployeeStatusHookContext,
  event: EmploymentRecordEvent,
  row: { kind: string; targetType: string; targetId: string; detail: object },
) => ({
  tenantId: hook.tenantId,
  businessId: event.recordId,
  employeeId: event.employeeId,
  phase: 'effective',
  commandId: hook.commandId,
  createdAt: hook.now,
  ...row,
});

/** 离职生效要结束的兼职及其新结束日（null = 不动）；生效钩子与离职预览（F-429 ②）共用这一个选择。 */
export function partTimesToEnd<T extends { startDate: string; endDate: string | null }>(
  records: readonly T[],
  lastDay: string,
) {
  return records.flatMap((record) => {
    const endDate = partTimeCutoffEnd(record, lastDay);
    return endDate === null ? [] : [{ record, endDate }];
  });
}

/** 离职生效要作废的未办结兼职申请：勾选的全部作废，未勾选的只作废日期晚于 L′ 的（DEC-725）；钩子与预览共用。 */
export function requestsToVoid(
  requests: readonly PartTimeRequestRow[],
  policy: ExitTerminationSetting | null,
  lastDay: string,
) {
  return requests.filter((request) => {
    const date = request.requestType === 'add' ? request.version.startDate : request.version.endDate;
    return terminates(policy, partTimeRequestFlow(request.requestType), date ?? null, lastDay);
  });
}

async function endPartTimesByExit(tx: Tx, hook: EmployeeStatusHookContext, event: EmploymentRecordEvent) {
  const [exit] = rowsOf<{ staffId: string }>(
    await tx.execute(sql`SELECT staff_id AS "staffId" FROM employment_records
      WHERE tenant_id=${hook.tenantId} AND employee_id=${event.employeeId}::uuid AND id=${event.recordId}::uuid`),
  );
  if (!exit) return;
  const ctx: EmploymentContext = { ...hook, expectedRevision: 0 };
  const lastDay = partTimeExitEndDate(event.effectiveDate);
  const locked = await lockPartTimeRecords(tx, ctx, event.employeeId, { staffId: exit.staffId });
  for (const { record, endDate } of partTimesToEnd(locked, lastDay)) {
    const next = await appendPartTimeTerm(tx, ctx, record, { endDate, source: 'exit', sourceId: event.recordId });
    await tx.insert(exitEffects).values(
      effectRow(hook, event, {
        kind: 'part_time_ended',
        targetType: 'part-time-record',
        targetId: record.id,
        detail: { originalEndDate: record.endDate, endDate, termNo: next.termNo },
      }),
    );
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
  const policy = await exitTerminationOf(tx, ctx.tenantId, event.kind);
  const lastDay = partTimeExitEndDate(event.effectiveDate);
  const requests = requestsToVoid(await lockOpenRequests(tx, ctx, event.employeeId), policy, lastDay);
  await lockOpenInstances(tx, ctx, requests);
  for (const request of requests) {
    await voidPartTimeRequest(tx, ctx, request, {
      reason: 'exit',
      action: 'part_time.request.voided_by_exit',
      template: PART_TIME_NOTICE_TEMPLATES.voidedByExit,
    });
    await tx.insert(exitEffects).values(
      effectRow(hook, event, {
        kind: 'part_time_request_voided',
        targetType: 'part-time-request',
        targetId: request.id,
        detail: { requestType: request.requestType, stateBefore: request.state, recordId: request.recordId },
      }),
    );
  }
}

/** 模块级单例：同名同实例重复登记幂等（status-hooks.ts 既有规则），createApp 多次调用安全（§4.9）。 */
export const PART_TIME_EXIT_HOOKS: EmployeeStatusHooks = {
  async onRecordMaterialized(tx, ctx, event) {
    if (!PART_TIME_TERMINATION_KINDS.includes(event.kind)) return;
    await endPartTimesByExit(tx, ctx, event);
    await voidRequestsByExit(tx, ctx, event);
  },
};
