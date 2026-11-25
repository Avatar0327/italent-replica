import type { Tx } from '@italent/db';
import { adoptCommandContext, commandContext, scopedGuard, type ScopedCommandGuard } from '../employment/context.js';
import { requireBusinessWriteScope } from '../employment/replay-guard.js';
import type { EmploymentBusinessPatch, EmploymentContext } from '../employment/types.js';
import type { TenantRouteDeps } from '../../routes.js';
import {
  lockSameOrderTarget,
  transferBusinessContext,
  type SameOrderLockTarget,
  transferTargetContext,
  type TransferInput,
} from './service.js';

/**
 * 调动单“同单写”入口的统一 CommandGuard（#403 第 3 轮 P2，DEC-431① 同类统一）。
 *
 * 入口（事务外）算出的数据范围与 Switch 31 目标部门例外（transferTarget）只是请求内快照。命令事务里不能再沿用它们：
 * 重放命中台账时执行体不会再跑，范围收空后仍会把原回执（单据、员工、目标部门、生效日期）返回出去。
 * 这里在 CommandGuard.before（首次执行、直接重放、失败回查都先经过它）里，严格按这个顺序（DEC-993 单入口）：
 *   0. 取锁阶段（lock 步骤，lockSameOrderTarget；F-560 起全部任职写入口都经这一步，取锁目标是各入口守卫的必填参数）：先循环取齐参与员工闭包（含请求新带入、且现存的下属）与员工行，
 *      再统一锁各参与者业务头，复核集合没有变大后封口。此时一个授权输入都还没读——等锁期间别人收回的授权，要在等完锁之后才读；
 *      封口之后本事务不再因新参与者等锁（需要新锁就 409 TRANSFER_LOCK_PLAN_CHANGED，放弃本事务，由重入先取齐锁再读授权）；
 *   1. 丢掉入口的旧例外，按当前授权解析数据范围（commandContext）并重判入口旗标（trustedScopeBypass）——这两项各解析一次；
 *   2. 重算同单来源与目标例外（transferBusinessContext 'command' / transferTargetContext）：只消费第 1 步的范围；
 *      Switch 31 备选来源会逐个发起人类型重查按钮与来源关系（可能与第 3 步再各查一次 Transfer.Hr 等按钮）；
 *   3. 由调用方的 authorize 按新上下文复核对象 / 按钮 / 字段 / 业务特有来源；
 *   4. 登记为本事务的命令上下文（adoptCommandContext）——执行体、重放复核、结果复核和回执裁剪（runWrite）都读这一份。
 * 承诺的是“授权输入全部在封口之后、同一事务里读”，不是“每个授权输入只查一次”：第 1～3 步之间没有任何会阻塞的等锁，
 * 重复查询读到的只会是同样或更新的授权；后一次读到撤权就按撤权拒绝（fail-closed），不会拿等锁之前的旧值放行（DEC-996）。
 * 第 4 轮 P2：上一版先解析范围、再在 derive 里等锁，等锁期间收回的范围仍被沿用（锁内字段校验通过后返回 200 + 原回执）。
 * 第 5 轮 P2：取锁阶段只按“第一次规划”取锁，derive 里第二次规划发现新进参与者时仍会在读完范围之后等锁；回执裁剪还在用入口范围。
 * 第 6 轮 P2：补锁循环每轮都连业务头一起锁，第二轮会在持甲、乙业务头时等丙的员工锁（逆序）；现分两段，员工锁全部先于业务头。
 * 第 7 轮 P2-1：单人闭包的业务头段什么都不锁，首次执行在读完授权之后才等本单业务头；现单人闭包也在封口前锁本单业务头。
 * 第 7 轮 P2-2：回执里的字典显示值（用工形式 / 人员类别名称）随命令保存（receiptNames），重放不再现查字典名。
 * 第 8 轮 P2：上一版在本函数里无条件开启 receiptNames，通用 PATCH / 状态动作 / 生效重试 / 通用新建对转正等非调动单据
 *   也经这里，非调动单据的重放就改成了旧名（与详情不一致）。现由各入口按“是否调动单”显式传入，这里不再替调用方决定。
 * 凡是会写同一张调动单或对它做状态动作、并走命令台账的入口都用这里，不要各写一套。
 */
/**
 * 命令事务内重算上下文的公共步骤：（可选）先取锁 → 丢掉入口的旧例外 → 当前范围与旗标 → 由调用方派生同单来源 / 例外 → 复核 →
 * 登记为命令上下文。`lock` 必须在读任何授权输入之前完成，之后读到的全部授权输入都是锁内的当前值。
 * `receiptNames` 只改回执的字典显示值来源，不影响取锁点、授权读取时机与错误码。
 */
function refreshGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  receiptNames: boolean,
  derive: (tx: Tx, fresh: EmploymentContext) => Promise<EmploymentContext>,
  check: (tx: Tx, scoped: EmploymentContext) => Promise<void>,
  lock: SameOrderLockTarget,
): ScopedCommandGuard {
  const guard = scopedGuard({
    before: async (tx) => {
      await lockSameOrderTarget(tx, entry, lock);
      const resolved = await commandContext(tx, deps, { ...entry, transferTarget: undefined });
      // 入口旗标是入口时读的 data.scope.all：它决定写入口径范围之外还要不要追加 tenant.employment.write，也属于授权输入，
      // 在取完锁的任职写入口里按本事务当前授权重判（入口未带旗标的上下文原样不动）。
      const fresh =
        entry.trustedScopeBypass !== undefined
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
  // 调动单（S4）回执的字典显示值随命令保存（DEC-999）：重放（直接 / 失败回查）原文不随字典改名而变。
  // 非调动单据不开启，重放照旧按字典现名补名称，与详情一致（DEC-1000）。
  return receiptNames ? { ...guard, receiptNames: true } : guard;
}

/**
 * 回执的字典显示值是否随命令保存（DEC-999 / DEC-1000）：只有调动单（kind = 'transfer'，含跨部门 / 跨组织 / 批量等表单）开启。
 * 各入口必须显式给出，不设缺省：共享守卫不知道调用它的是哪类单据。
 */
export interface ReceiptNamesSpec {
  readonly receiptNames: boolean;
}
/** 通用入口按单据类型判定：只有调动单开启回执名称保存。 */
export const transferReceiptNames = (kind: string): ReceiptNamesSpec => ({ receiptNames: kind === 'transfer' });

export interface SameOrderSpec extends ReceiptNamesSpec {
  readonly businessId: string;
  readonly employeeId?: string;
  /** 编辑可改目标部门：按新部门重算目标例外。 */
  readonly targetDepartmentId?: string | null;
  readonly referenceChange?: EmploymentBusinessPatch;
  /** 命令事务内按新上下文重过的授权（对象 / 按钮 / 字段 / 业务特有来源），在同单来源之后、写入口径范围之前。 */
  readonly authorize: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
  /**
   * 业务写范围复核通过之后才跑的状态复判（如提交时 J5 字段适用性）。它会披露单据的当前状态（409 与否），
   * 所以必须排在授权与范围之后：范围已收空的人只会得到与对照请求一致的 404。首次执行、同键重放与失败回查
   * 都经 CommandGuard.before，先于台账缓存回执，所以这里是该复判唯一的入口。
   */
  readonly afterScope?: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
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
    spec.receiptNames,
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
      await spec.afterScope?.(tx, scoped);
    },
    // 请求新带入的下属也在取锁阶段一并取齐：写入执行体里的取锁此后都是重入，封口后不会再等锁。
    // 查无此人的不在这里报错，留给首次执行的业务校验，免得遮蔽同键异内容的 409（第 5 轮 P2-3）。
    // 非调动单据也经这里：发起员工从 employment_business_objects 解析（F-560），此前它们什么都不锁。
    { businessId: spec.businessId, extra: spec.referenceChange?.fields?.addedSubordinateIds ?? [] },
  );
}

/**
 * 不经同单来源、也没有目标部门例外的同单写入口（联动保存 / 重试、生效重试）：只按本事务内的当前范围重验，
 * 重放与失败回查不沿用入口的旧范围。writeScope 给出时再按写入口径范围判该调动单。
 */
export function sameOrderScopeGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  spec: ReceiptNamesSpec & {
    /** 取锁目标（必填，F-560）：每个入口都得说清“锁谁”，没法漏掉取锁直接读授权。 */
    readonly lock: SameOrderLockTarget;
    readonly authorize: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
    readonly writeScope?: { readonly businessId: string; readonly employeeId?: string };
  },
): ScopedCommandGuard {
  return refreshGuard(
    deps,
    entry,
    spec.receiptNames,
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
    spec.lock,
  );
}

/** 发起 / 覆盖暂存（POST /transfers/employees/:id）：目标部门例外由 transferTargetContext 按当前范围重算。 */
export function sameOrderCreateGuard(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  spec: ReceiptNamesSpec & {
    readonly employeeId: string;
    readonly input: TransferInput;
    readonly targetDepartmentId: string | null;
    /** 请求新带入的下属（addedSubordinateIds 与职责转交下属）：与发起员工一起在取锁阶段取齐。 */
    readonly extraParticipants: readonly string[];
    readonly authorize: (tx: Tx, scoped: EmploymentContext) => Promise<void>;
  },
): ScopedCommandGuard {
  return refreshGuard(
    deps,
    entry,
    spec.receiptNames,
    async (tx, fresh) => {
      await spec.authorize(tx, fresh);
      return transferTargetContext(tx, fresh, spec.employeeId, spec.input, spec.targetDepartmentId);
    },
    async () => undefined,
    { employeeId: spec.employeeId, extra: spec.extraParticipants },
  );
}
