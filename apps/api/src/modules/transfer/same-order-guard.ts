import type { Tx } from '@italent/db';
import { adoptCommandContext, commandContext, scopedGuard, type ScopedCommandGuard } from '../employment/context.js';
import { requireBusinessWriteScope } from '../employment/replay-guard.js';
import type { EmploymentBusinessPatch, EmploymentContext } from '../employment/types.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  lockTransferBusinessEmployee,
  transferBusinessContext,
  transferTargetContext,
  type TransferInput,
} from './service.js';

/**
 * 调动单“同单写”入口的统一 CommandGuard（#403 第 3 轮 P2，DEC-431① 同类统一）。
 *
 * 入口（事务外）算出的数据范围与 Switch 31 目标部门例外（transferTarget）只是请求内快照。命令事务里不能再沿用它们：
 * 重放命中台账时执行体不会再跑，范围收空后仍会把原回执（单据、员工、目标部门、生效日期）返回出去。
 * 这里在 CommandGuard.before（首次执行、直接重放、失败回查都先经过它）里，严格按这个顺序：
 *   0. 先取锁（参与员工 → 员工行，lock 步骤）：此时一个授权输入都还没读——等锁期间别人收回的授权，要在等完锁之后才读；
 *   1. 丢掉入口的旧例外，在锁内按当前授权解析数据范围（commandContext）并重判入口旗标（trustedScopeBypass）；
 *   2. 重算同单来源与目标例外（transferBusinessContext 'command' / transferTargetContext）；
 *   3. 由调用方的 authorize 按新上下文复核对象 / 按钮 / 字段 / 业务特有来源；
 *   4. 登记为本事务的命令上下文（adoptCommandContext）——执行体、重放复核和结果复核都读这一份。
 * 第 4 轮 P2：上一版先解析范围、再在 derive 里等锁，等锁期间收回的范围仍被沿用（锁内字段校验通过后返回 200 + 原回执）。
 * 凡是会写同一张调动单或对它做状态动作、并走命令台账的入口都用这里，不要各写一套。
 */
/**
 * 命令事务内重算上下文的公共步骤：（可选）先取锁 → 丢掉入口的旧例外 → 当前范围与旗标 → 由调用方派生同单来源 / 例外 → 复核 →
 * 登记为命令上下文。`lock` 必须在读任何授权输入之前完成，之后读到的全部授权输入都是锁内的当前值。
 */
function refreshGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  derive: (tx: Tx, fresh: EmploymentContext) => Promise<EmploymentContext>,
  check: (tx: Tx, scoped: EmploymentContext) => Promise<void>,
  lock?: (tx: Tx) => Promise<void>,
): ScopedCommandGuard {
  return scopedGuard({
    before: async (tx) => {
      await lock?.(tx);
      const resolved = await commandContext(tx, deps, { ...entry, transferTarget: undefined });
      // 入口旗标是入口时读的 data.scope.all：它决定写入口径范围之外还要不要追加 tenant.employment.write，也属于授权输入，
      // 只在上了锁的同单写入口里按本事务当前授权重判（入口未带旗标的上下文原样不动）。
      const fresh =
        lock && entry.trustedScopeBypass !== undefined
          ? {
              ...resolved,
              trustedScopeBypass: await resolved.authorize!({
                tenantId: entry.tenantId,
                userId: entry.userId,
                timezone: entry.timezone,
                action: 'data.scope.all',
              }),
            }
          : resolved;
      const scoped = await derive(tx, fresh);
      await check(tx, scoped);
      adoptCommandContext(tx, entry, scoped);
    },
  });
}

export interface SameOrderSpec {
  readonly businessId: string;
  readonly employeeId?: string;
  /** 编辑可改目标部门：按新部门重算目标例外。 */
  readonly targetDepartmentId?: string | null;
  readonly referenceChange?: EmploymentBusinessPatch;
  /** 命令事务内按新上下文重过的授权（对象 / 按钮 / 字段 / 业务特有来源），在同单来源之后、写入口径范围之前。 */
  readonly authorize: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
}

/** 经调动同单来源（transferBusinessContext）的入口：通用编辑 / 提交 / 撤回 / 撤销 / 删除、暂存清除。 */
export function sameOrderWriteGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  spec: SameOrderSpec,
): ScopedCommandGuard {
  return refreshGuard(
    deps,
    entry,
    async (tx, fresh) => {
      // 锁已在 lock 步骤取完（'command' 阶段再取是幂等的）；同单来源、草稿上的同值判定、保存值可信度和字段写权
      // 读的是锁保护的当前载荷与锁内范围；首次执行、缓存重放、失败回查都经此处，缓存命中后才交出旧结果（第 3 轮 P2-1，DEC-431①）。
      const scoped = await transferBusinessContext(
        tx,
        fresh,
        spec.businessId,
        'command',
        spec.targetDepartmentId,
        spec.referenceChange,
      );
      return spec.targetDepartmentId !== undefined && scoped.transferTarget
        ? { ...scoped, transferTarget: { ...scoped.transferTarget, departmentId: spec.targetDepartmentId } }
        : scoped;
    },
    async (tx, scoped) => {
      await spec.authorize(tx, scoped);
      await requireBusinessWriteScope(tx, scoped.authorize!, scoped, spec.businessId, spec.employeeId);
    },
    (tx) => lockTransferBusinessEmployee(tx, entry, spec.businessId),
  );
}

/**
 * 不经同单来源、也没有目标部门例外的同单写入口（联动保存 / 重试、生效重试）：只按本事务内的当前范围重验，
 * 重放与失败回查不沿用入口的旧范围。writeScope 给出时再按写入口径范围判该调动单。
 */
export function sameOrderScopeGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  spec: {
    readonly authorize: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
    readonly writeScope?: { readonly businessId: string; readonly employeeId?: string };
  },
): ScopedCommandGuard {
  return refreshGuard(
    deps,
    entry,
    async (_tx, fresh) => fresh,
    async (tx, scoped) => {
      await spec.authorize(tx, scoped);
      if (spec.writeScope)
        await requireBusinessWriteScope(
          tx,
          scoped.authorize!,
          scoped,
          spec.writeScope.businessId,
          spec.writeScope.employeeId,
        );
    },
  );
}

/** 发起 / 覆盖暂存（POST /transfers/employees/:id）：目标部门例外由 transferTargetContext 按当前范围重算。 */
export function sameOrderCreateGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  spec: {
    readonly employeeId: string;
    readonly input: TransferInput;
    readonly targetDepartmentId: string | null;
    readonly authorize: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
  },
): ScopedCommandGuard {
  return refreshGuard(
    deps,
    entry,
    async (tx, fresh) => {
      await spec.authorize(tx, fresh);
      return transferTargetContext(tx, fresh, spec.employeeId, spec.input, spec.targetDepartmentId);
    },
    async () => undefined,
  );
}
