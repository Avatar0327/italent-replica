/**
 * 离职预览的兼职部分（F-429 ②）：只读列出离职生效时将结束的兼职与将作废的未办结申请。
 * 选择与生效钩子（exit-hook.ts）逐项相同——同用 partTimesToEnd / requestsToVoid，同一 L′ 与勾选；
 * 与钩子不同的是不加行锁、不写任何数据。任职周期取最后工作日所在周期（钩子取离职单所属周期，二者同值）。
 */
import { partTimeExitEndDate } from '@italent/domain';
import type { Tx } from '@italent/db';
import { cycleOn } from '../exit-occupancy-store.js';
import { exitTerminationOf } from '../exit-termination-policy.js';
import { dayAfter } from '../fields.js';
import type { EmploymentContext } from '../types.js';
import { partTimesToEnd, requestsToVoid } from './exit-hook.js';
import { readOpenRequests } from './request-store.js';
import { readEmployeePartTimeRecords } from './store.js';

export interface PartTimeExitCandidate {
  readonly action: 'end' | 'void';
  readonly targetType: 'part-time-record' | 'part-time-request';
  readonly targetId: string;
  /** DEC-177 披露用的所属部门。 */
  readonly departmentId: string | null;
}

export async function previewPartTimesOnExit(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  kind: 'leave' | 'retirement',
): Promise<PartTimeExitCandidate[]> {
  const lastDay = partTimeExitEndDate(dayAfter(lastWorkDate));
  const staffId = await cycleOn(tx, ctx.tenantId, employeeId, lastWorkDate);
  const records = staffId ? await readEmployeePartTimeRecords(tx, ctx, employeeId, staffId) : [];
  const policy = await exitTerminationOf(tx, ctx.tenantId, kind);
  const requests = requestsToVoid(await readOpenRequests(tx, ctx, employeeId), policy, lastDay);
  return [
    ...partTimesToEnd(records, lastDay).map(({ record }) => ({
      action: 'end' as const,
      targetType: 'part-time-record' as const,
      targetId: record.id,
      departmentId: record.departmentId,
    })),
    ...requests.map((request) => ({
      action: 'void' as const,
      targetType: 'part-time-request' as const,
      targetId: request.id,
      departmentId: request.version.departmentId ?? null,
    })),
  ];
}
