/**
 * 离职预览的合同与兼职部分（F-429 ②）：EXIT_CONTRACTS_TO_HANDLE / EXIT_PART_TIMES_TO_END 两项 warning。
 * 集合由生效时用的同一选择函数给出（合同端口 previewContractsOnExit、兼职 previewPartTimesOnExit），预览 = 执行；
 * 清单只含动作、目标类型与目标 ID，不可见的只计入 hiddenCount：合同类按合同对象查看权（§9.1，同撤销清单口径），
 * 兼职按所属部门走 DEC-177 披露。无条目时不追加。这两项只提示，不进 §8 确认令牌（令牌只覆盖会 409 拦截的调动 / 考核 / 流程）。
 */
import type { Tx } from '@italent/db';
import { previewContractsOnExit } from '../contracts/ports.js';
import { allowed } from './exit-downstream.js';
import { batchDisclose } from './exit-gate.js';
import { exitTerminationOf } from './exit-termination-policy.js';
import { previewPartTimesOnExit } from './part-time/exit-preview.js';
import type { EmploymentContext } from './types.js';
import { CONTRACT_OBJECT } from '@italent/domain';

export interface Shown {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
}

export async function contractExitWarning(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  kind: 'leave' | 'retirement',
) {
  const termination = await exitTerminationOf(tx, ctx.tenantId, kind);
  const found = await previewContractsOnExit(tx, ctx.tenantId, { employeeId, lastWorkDate, termination });
  const all: Shown[] = [
    ...found.terminated.map((id) => ({ action: 'terminate', targetType: 'contract', targetId: id })),
    ...found.deleted.map((id) => ({ action: 'delete', targetType: 'contract', targetId: id })),
    ...found.withdrawnRequests.map((id) => ({ action: 'withdraw', targetType: 'contract-request', targetId: id })),
  ];
  if (!all.length) return [];
  const items = (await allowed(ctx, CONTRACT_OBJECT)) ? all : [];
  return [{ reason: 'EXIT_CONTRACTS_TO_HANDLE', items, hiddenCount: all.length - items.length }];
}

export async function partTimeExitWarning(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  lastWorkDate: string,
  kind: 'leave' | 'retirement',
) {
  const found = await previewPartTimesOnExit(tx, ctx, employeeId, lastWorkDate, kind);
  if (!found.length) return [];
  const shown = await batchDisclose(
    tx,
    ctx,
    employeeId,
    found.map((item) => ({ id: item.targetId, effectiveDate: '', departmentId: item.departmentId })),
  );
  const visible = new Set(shown.items.map((item) => item.businessId));
  const items: Shown[] = found
    .filter((item) => visible.has(item.targetId))
    .map(({ action, targetType, targetId }) => ({ action, targetType, targetId }));
  return [{ reason: 'EXIT_PART_TIMES_TO_END', items, hiddenCount: found.length - items.length }];
}
