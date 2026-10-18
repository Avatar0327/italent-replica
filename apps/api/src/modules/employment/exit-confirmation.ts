/**
 * 离职 confirmed 阶段（R2-T03 设计 §3.1）：申请最后节点同意、直接离职保存时调用，与该动作同事务。
 * 写编制预减时点 R（exit_requests.pre_release_date，DEC-266①）与预减台账（establishment/exit-release.ts），
 * 再通知 confirmed 端口的订阅方（交接自动发起属 BE-8b，DM-R14：只对申请；本批没有订阅方）。不落地（§18.1）。
 * approval_passed 时机的职责转交在 B3-2 接入（关口⑤期间请求不能带转交区块）。
 */
import { and, eq, exitRequests, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { registerEstablishmentPreRelease } from '../establishment/exit-release.js';
import { auditEmployment } from './context.js';
import { loadEmploymentBusiness } from './read-model.js';
import type { EmploymentContext } from './types.js';

export interface ExitConfirmedEvent {
  readonly businessId: string;
  readonly employeeId: string;
  readonly mode: 'application' | 'direct';
}

type ConfirmedHook = (tx: Tx, ctx: EmploymentContext, event: ExitConfirmedEvent) => Promise<void>;
const confirmedHooks: ConfirmedHook[] = [];

/** 离职生效来源：审批通过 / 直接离职保存 / 免审批直接生效（DEC-593，BE-6b 结束实习）。 */
export type ExitActivationSource = 'approval' | 'direct' | 'free_direct';

export interface ExitEffectiveEvent {
  readonly businessId: string;
  readonly employeeId: string;
  readonly source: ExitActivationSource;
  readonly lastWorkDate: string;
  readonly effectiveDate: string;
}

type EffectiveHook = (tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent) => Promise<void>;
const effectiveHooks: EffectiveHook[] = [];

/**
 * 离职后续任务端口（设计 §0 / §5.1 步骤 8）：confirmed 在审批通过 / 直接离职保存时调用（DM-R14 交接自动发起，BE-8）；
 * effective 在离职落地后调用（自动加黑 BE-8、账号停用另行任务）。订阅方在同一事务内处理，失败即整单回滚；默认没有订阅方。
 */
export const exitPostEffectHooks = {
  onConfirmed(hook: ConfirmedHook): void {
    confirmedHooks.push(hook);
  },
  onEffective(hook: EffectiveHook): void {
    effectiveHooks.push(hook);
  },
};

export async function runExitEffectiveHooks(tx: Tx, ctx: EmploymentContext, event: ExitEffectiveEvent) {
  for (const hook of effectiveHooks) await hook(tx, ctx, event);
}

/** 进入 confirmed 阶段的离职单：业务 ID、员工、计划生效日 E、办理方式。 */
export interface ConfirmedExit {
  readonly id: string;
  readonly employeeId: string;
  readonly effectiveDate: string;
  readonly mode: 'application' | 'direct';
}

export async function confirmExit(tx: Tx, ctx: EmploymentContext, business: ConfirmedExit) {
  const releasedFrom = tenantLocalDate(ctx.now, ctx.timezone);
  const where = and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, business.id));
  const [row] = await tx.select({ preReleaseDate: exitRequests.preReleaseDate }).from(exitRequests).where(where);
  // R 一经写入不再改变（迟到顺延、重试都不改），已有 R 说明本阶段已执行过
  if (!row || row.preReleaseDate) return;
  await tx.update(exitRequests).set({ preReleaseDate: releasedFrom }).where(where);
  // 部门 / 职位取按继承解析后的值（与审批快照同一读模型），载荷里未填的字段从前一条任职带出
  const resolved = await loadEmploymentBusiness(tx, ctx.tenantId, business.id, releasedFrom);
  const effects = await registerEstablishmentPreRelease(tx, ctx, {
    businessId: business.id,
    employeeId: business.employeeId,
    departmentId: resolved?.fields.departmentId ?? null,
    positionId: resolved?.fields.positionId ?? null,
    releasedFrom,
    plannedEffectiveDate: business.effectiveDate,
  });
  await auditEmployment(
    tx,
    ctx,
    'exit.establishment.pre_released',
    'exit-request',
    business.id,
    { preReleaseDate: null },
    { preReleaseDate: releasedFrom, effects },
    undefined,
    undefined,
    { employeeId: business.employeeId },
  );
  const event = { businessId: business.id, employeeId: business.employeeId, mode: business.mode };
  for (const hook of confirmedHooks) await hook(tx, ctx, event);
}
