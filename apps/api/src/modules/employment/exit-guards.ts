/**
 * 离职 / 退休 / 实习生写入口的命令内复核（CommandGuard.before，#199 / F-195），F-565③ 起统一建在 F-560 的同单守卫上：
 * 员工行 → 业务头 → 封口 → 锁内读授权 → 复核 → 登记命令上下文。
 *
 * 此前这些守卫在 before 里先 commandContext（读数据范围）再复核，把范围缓存成本事务的命令上下文；执行体随后才等员工行锁，
 * 等锁期间别人收回的范围仍按旧值写入（锁外读授权、锁内沿用）。现在经 sameOrderScopeGuard：授权输入一个都不在取锁阶段之前读。
 * 取锁目标由入口给出的标识决定：已有业务（businessId）按业务头解析发起员工；创建（还没有业务）按员工 + 请求带入的职责转交下属。
 * 复核原语（requireExitScope / requireExitPermission / requireExitEditRights / requireInternRegularizationAccess）仍在
 * replay-guard.ts / exit-gate.ts，只换调用时机。不在 replay-guard.ts 里直接建在同单守卫上，是避免 replay-guard ↔ transfer 的循环依赖。
 */
import type { Tx } from '@italent/db';
import type { TenantRouteDeps } from '../../routes.js';
import { sameOrderScopeGuard, transferReceiptNames } from '../transfer/same-order-guard.js';
import type { SameOrderLockTarget } from '../transfer/service.js';
import type { ScopedCommandGuard } from './context.js';
import { exitDutySubordinates } from './exit-lock-plan.js';
import { requireExitPermission, type ExitGateTarget, type ExitOperation } from './exit-gate.js';
import {
  exitBatchFailure,
  exitBatchRejected,
  requireExitEditRights,
  requireExitScope,
  requireInternRegularizationAccess,
  type ExitBatchFailure,
  type ExitBatchItem,
  type ExitScopeTarget,
} from './replay-guard.js';
import { existingTransferEmployees } from './transfer-locks.js';
import type { EmploymentContext } from './types.js';

/** 离职类入口不是调动单：回执字典名不随命令保存（与通用新建对非调动类型一致，DEC-1000）。 */
const notTransfer = transferReceiptNames('leave');

/** 已有业务按业务头定位；创建按员工，并带上请求里职责转交的下属（与 createExitApplication 取齐的闭包一致）。 */
function exitLockTarget(
  target: ExitGateTarget,
  scopeTarget: ExitScopeTarget,
  cancellationId?: string,
): SameOrderLockTarget {
  // allHeads：改期 / 生效重试 / 直接生效作废转正等执行体会在读授权之后才锁该员工的其他业务头（lockOtherBusinessHeads），
  // 一律提前到封口之前取齐（F-565 第 2 轮 P2-2，员工 → 业务头 → 子记录）；执行体里的再取是重入。
  return scopeTarget.businessId
    ? { businessId: scopeTarget.businessId, allHeads: true }
    : {
        employeeId: target.employeeId,
        extra: exitDutySubordinates(target.exit?.dutyTransfer),
        allHeads: true,
        ...(cancellationId ? { cancellationId } : {}),
      };
}

/**
 * 离职入口（create / PATCH / submit / withdraw / DELETE /businesses/:id / activation/retry）的命令内复核：
 * 首次执行、同键重放、失败回查三个出口都先取锁、再在命令事务内按当前授权重新解析数据范围，校验员工、业务和请求里显式给出的
 * 目标部门的写入范围，再过 Dimission* 权限链。创建时没填的部门是从时间线继承来的（PATCH 也会重算继承），请求里看不到，
 * 由 runWrite 在同一份事务内范围上校验实际写入的结果（执行后）和原响应（重放时）。
 *
 * `entryAuthorize`：入口自己另有的授权检查（F-565 第 2 轮 P1-1：通用新建 POST /employees/:id/businesses 的离职 / 退休分支在入口
 * 先验了对象新增权与通用新建按钮 Employment.Create 及实际请求字段，命令内也必须重验同一组，否则等锁期间只撤通用按钮仍 201）。
 * 在离职专属复核之前执行，口径与 genericCreateGuard 一致；专用入口不传，继续只用各自的按钮契约。
 */
export function exitCommandGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  operation: ExitOperation,
  target: ExitGateTarget,
  scopeTarget: ExitScopeTarget,
  entryAuthorize?: (tx: Tx, scoped: EmploymentContext) => Promise<void>,
  cancellationId?: string,
): ScopedCommandGuard {
  return sameOrderScopeGuard(deps, ctx, {
    ...notTransfer,
    lock: exitLockTarget(target, scopeTarget, cancellationId),
    authorize: async (tx, scoped) => {
      await entryAuthorize?.(tx, scoped);
      await requireExitScope(tx, scoped, target, scopeTarget);
      await requireExitPermission(scoped, operation, target);
    },
  });
}

/**
 * 编辑离职 PATCH exits/:id 的命令内复核：同 exitCommandGuard（update），另加——单据处于审批中时，HR 编辑与审批编辑同约束，
 * DimissionEdit 之外还要审批管理员（干预）按钮（设计 §4B / §9.1 PATCH 行，B-65a）。状态取命令事务内读到的当前值；
 * 读到之后若单据被提交 / 撤回，业务 revision 已变，If-Match 不符，本命令随即 409。
 */
export function exitEditGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  target: ExitGateTarget,
  businessId: string,
  checkLinkedFields?: (tx: Tx, scoped: EmploymentContext) => Promise<void>,
  /** 请求新增的职责转交下属（退休计划）：与执行体 lockExitForEdit 的参与人规划同一份，封口前纳入闭包（F-565 第 2 轮 P2-1）。 */
  dutySubordinates: readonly string[] = [],
): ScopedCommandGuard {
  return sameOrderScopeGuard(deps, ctx, {
    ...notTransfer,
    // exitEdit：已有离职单改期会重做剩余失败职责，其下属也要在封口前入集合（F-140b2）；allHeads 见 exitLockTarget
    lock: { businessId, extra: dutySubordinates, exitEdit: true, allHeads: true },
    authorize: async (tx, scoped) => {
      await requireExitScope(tx, scoped, target, { businessId });
      await requireExitEditRights(tx, scoped, target, businessId);
      await checkLinkedFields?.(tx, scoped);
    },
  });
}

/** 批量离职整批参与员工闭包的取锁目标：存在的离职员工 + 各人的职责转交下属；查无此人的另行作为逐条原因，不进闭包。 */
async function exitBatchLockTarget(
  tx: Tx,
  ctx: EmploymentContext,
  items: readonly ExitBatchItem[],
): Promise<SameOrderLockTarget> {
  const employees = await existingTransferEmployees(
    tx,
    ctx,
    items.map((item) => item.employeeId),
  );
  const [owner, ...others] = employees;
  // 一个存在的员工都没有：取锁阶段什么都不锁（目标不存在），逐人原因由执行体报出；这里随便给首项即可。
  if (!owner) return { employeeId: items[0]?.employeeId ?? '' };
  return {
    employeeId: owner,
    extra: [...others, ...items.flatMap((item) => exitDutySubordinates(item.exit?.dutyTransfer))],
    allHeads: true,
  };
}

/**
 * 批量离职的命令内复核（#199）：逐人按当前授权重过员工范围与离职申请权限链（同单人创建的 exitCommandGuard）。
 * 某人不通过不在这里抛出，而是交给执行阶段与其余人的业务前置条件一起作为逐条原因（B-25 / B-64：整批 409、逐条原因）；
 * 命中台账的重放不再执行，有人不通过就在 replayed 里整批 409，不返回缓存的成功回执。
 * 取锁阶段按整批闭包一次取齐（与 exit-batch.ts 的 lockExitParticipants 同一集合）。
 */
export function exitBatchGuard(deps: TenantRouteDeps, ctx: EmploymentContext, items: readonly ExitBatchItem[]) {
  let failures: ExitBatchFailure[] = [];
  const guard = sameOrderScopeGuard(deps, ctx, {
    ...notTransfer,
    lock: (tx) => exitBatchLockTarget(tx, ctx, items),
    authorize: async (tx, scoped) => {
      failures = [];
      for (const [index, item] of items.entries()) {
        const target: ExitGateTarget = {
          employeeId: item.employeeId,
          initiation: 'hr',
          mode: 'application',
          lastWorkDate: item.lastWorkDate,
          exit: item.exit ?? {},
        };
        try {
          await requireExitScope(tx, scoped, target, {});
          await requireExitPermission(scoped, 'create', target);
        } catch (error) {
          const failure = exitBatchFailure(index, item.employeeId, error);
          if (!failure) throw error;
          failures.push(failure);
        }
      }
    },
  });
  const replayed = async () => {
    if (failures.length) throw exitBatchRejected(failures);
  };
  return Object.assign({ ...guard, replayed }, { failures: () => failures });
}

/** 直接实习转正（BE-6a）的命令内复核：先取锁，再按当前授权重过入口同一口径（新增权、按钮、字段创建权、员工与目标部门范围）。 */
export function internRegularizationGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  employeeId: string,
  business: object,
  departmentId: string,
): ScopedCommandGuard {
  return sameOrderScopeGuard(deps, ctx, {
    ...notTransfer,
    lock: { employeeId, allHeads: true },
    authorize: (tx, scoped) => requireInternRegularizationAccess(tx, scoped, employeeId, business, departmentId),
  });
}
