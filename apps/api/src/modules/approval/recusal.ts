/**
 * F-048 回避判定的服务端包装（docs/08_设计/F-048_审批多主体回避_设计.md §4.2）：所有入口按实例冻结的 S / U(S) 判定，
 * 不再实时查“账号 → 人员”。回避事实在一次命令（Run）内缓存，冻结写入后刷新；结论不缓存，每次在冻结值上现算。
 * 账号来源的人（办理人、各类目标、异常管理员）只传账号；员工来源的表达式候选才带人员 ID（设计 §2.3）。
 */
import type { Tx } from '@italent/db';
import {
  avoidsSubjects,
  instanceRecusal,
  nodeRecusal,
  tenantLocalDate,
  type ApprovalNode,
  type RecusalFacts,
} from '@italent/domain';
import { approvalError } from './context.js';
import type { Run } from './engine.js';
import { isEligibleApprover, type EligibilityScope } from './resolver.js';
import { freezeSubjects, loadRecusalFacts } from './subjects.js';
import type { TaskRow } from './store.js';

/** 本次命令里实例的回避事实（读冻结行；存量实例按设计 §2.1 回退）。 */
export async function recusalFactsOf(tx: Tx, run: Run): Promise<RecusalFacts> {
  run.recusal ??= await loadRecusalFacts(tx, run.ctx.tenantId, run.instance);
  return run.recusal;
}

/** 重提冻结新一轮（设计 §5.2）：写入后丢弃缓存，之后的预检与路由读到新一轮。 */
export async function freezeRunSubjects(tx: Tx, run: Run, current: readonly string[]): Promise<void> {
  await freezeSubjects(tx, run.ctx, run.instance, run.instance.round, current);
  run.recusal = undefined;
}

/** 被判定的人在谁的口径上：办理人、转交 / 加签 / 改派目标、抄送目标。 */
export type RecusalRole = 'actor' | 'target' | 'cc';

/**
 * 命中即抛 409 APPROVAL_SELF_REVIEW（details.recusal = self | subjects）。
 * - actor：办理人（防御：冻结后不会新增命中）；异常管理员任务按实例级，其余按节点级；
 * - target：转交 / 加签 / 管理员改派的目标，节点级；
 * - cc：抄送目标，只在节点开启 avoidSubjects 时排除主体（DEC-329③）。
 */
export async function assertNotRecused(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  userId: string,
  role: RecusalRole,
  task?: Pick<TaskRow, 'isExceptionAdmin'>,
): Promise<void> {
  const hit = await recusalOf(
    tx,
    run,
    node,
    userId,
    role === 'actor' && task?.isExceptionAdmin === true,
    role === 'cc',
  );
  if (!hit) return;
  const message =
    role === 'cc'
      ? '不能抄送给本单涵盖的人员'
      : hit === 'self'
        ? '发起人或异动本人不能审批自己的单据'
        : '本单涵盖的人员不能审批自己的单据';
  throw approvalError('CONFLICT', 'APPROVAL_SELF_REVIEW', message, { recusal: hit });
}

async function recusalOf(
  tx: Tx,
  run: Run,
  node: ApprovalNode,
  userId: string,
  instanceLevel: boolean,
  subjectsOnly: boolean,
): Promise<'self' | 'subjects' | null> {
  const facts = await recusalFactsOf(tx, run);
  const who = { userId };
  if (instanceLevel) {
    if (!instanceRecusal(who, facts)) return null;
    return nodeRecusal({ actions: { avoidSelf: true, avoidSubjects: false } }, who, facts) ?? 'subjects';
  }
  if (subjectsOnly) {
    const hit = nodeRecusal({ actions: { avoidSelf: false, avoidSubjects: avoidsSubjects(node) } }, who, facts);
    return hit === null ? null : 'subjects';
  }
  return nodeRecusal(node, who, facts);
}

/**
 * 可接手：审批资格（账号有效、离职未生效）且不被回避（设计 §4.2）。用于排队激活、回到原审批人、会签重开；
 * 不可接手时调用方走一次 F8 路径（转异常管理员）。异常管理员任务按实例级，其余按节点级。
 */
export async function canTake(
  tx: Tx,
  run: Run,
  scope: EligibilityScope,
  task: Pick<TaskRow, 'nodeKey' | 'isExceptionAdmin'>,
  userId: string,
): Promise<boolean> {
  if (!(await isEligibleApprover(tx, scope, userId))) return false;
  const node = run.version.nodes.find((candidate) => candidate.key === task.nodeKey)!;
  return (await recusalOf(tx, run, node, userId, task.isExceptionAdmin, false)) === null;
}

/** 审批资格所需的租户与业务日期（目标校验用）。 */
export const eligibilityScope = (run: Run): EligibilityScope => ({
  tenantId: run.ctx.tenantId,
  asOf: tenantLocalDate(run.ctx.now, run.ctx.timezone),
});
