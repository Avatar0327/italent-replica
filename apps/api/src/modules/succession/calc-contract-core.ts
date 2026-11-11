/**
 * 计算契约的叶模块（F-512）：类型、CalcBlocked / CalcObjectFailure、defineCalcKinds、calcKey，原都在 calc-contract.ts。
 * 各 kind 的处理器（exit-sweep / org-stats / risk-worker / health-worker）顶层要用到这里的错误类，
 * 而 calc-contract 的登记表 SUCCESSION_CALC_KINDS 顶层又要读这些处理器：同在一个文件里就成环，以任一处理器为首个入口时
 * 登记表读到未初始化的处理器。拆开后处理器只依赖本文件；calc-contract 只剩登记表并对本文件原名再导出。
 * B3a / DEC-427：可信的模块内端口，不是 HTTP 授权入口。
 */
import { CALC_KINDS, type Tx, type successionCalcRuns, type successionCalcRunObjects } from '@italent/db';
import { calcScheduleSlot } from './calc-time.js';

export type CalcKind = (typeof CALC_KINDS)[number];
export type CalcRun = Readonly<typeof successionCalcRuns.$inferSelect>;
export type CalcObject = Readonly<typeof successionCalcRunObjects.$inferSelect>;
export interface CalcInput {
  readonly tenantId: string;
  readonly kind: CalcKind;
  readonly trigger: 'manual' | 'schedule' | 'preferences_change' | 'review_sync';
  readonly commandId: string;
  readonly requestedBy: string | null;
  readonly businessDate: string;
  readonly objects: readonly (Pick<CalcObject, 'objectType' | 'objectId'> & { expectedRevision?: number })[];
  readonly scope?: { rootOrgId?: string; sourceBatchId?: string };
  readonly timezone?: string;
  readonly now?: Date;
  readonly intervalHours?: number;
  readonly preferencesRevision?: number;
  readonly batchId?: string;
}
export interface CalcContext {
  readonly tx: Tx;
  readonly run: CalcRun;
  readonly now: Date;
}
export interface CalcHandler {
  readonly kind: CalcKind;
  readonly objectType: CalcObject['objectType'];
  /** 每页（包括空集合）重验当前系统主体/所属人、standard_succession_runner、对象权限与非空范围。
   * 从租户设置解析，返回当前系统主体；失效抛 CalcBlocked。禁止外部 IO 或获取其他 run 的锁。 */
  authorizePage(ctx: CalcContext): Promise<string>;
  /** 在整页根事务内、任何对象保存点之前统一准备领域锁；首次执行与重试共用。
   * 只准备锁，不写业务值；禁止外部 IO 或获取其他 run 的锁。未提供时维持对象级执行。 */
  preparePage?(ctx: CalcContext, objects: readonly CalcObject[]): Promise<void>;
  /** 在提供的对象保存点事务内执行；不得自行提交/启动事务。按领域锁序取对象锁，再复核范围、资格、
   * expectedRevision 与字段权限；失败抛 CalcObjectFailure。业务审计/outbox 必须也用 ctx.tx。
   * 返回 failed 不可作为正常结果；未知异常回滚整页并 blocked，不能吞错变成 unchanged。 */
  execute(ctx: CalcContext, object: CalcObject): Promise<'written' | 'unchanged' | 'manual_kept'>;
}
export function defineCalcKinds(handlers: readonly CalcHandler[]): readonly CalcHandler[] {
  const seen = new Set<string>();
  for (const handler of handlers) {
    if (!CALC_KINDS.includes(handler.kind) || seen.has(handler.kind)) throw new Error('计算 kind 重复或未登记');
    seen.add(handler.kind);
  }
  return Object.freeze(
    handlers.map((handler) =>
      Object.freeze({
        kind: handler.kind,
        objectType: handler.objectType,
        authorizePage: handler.authorizePage.bind(handler),
        ...(handler.preparePage ? { preparePage: handler.preparePage.bind(handler) } : {}),
        execute: handler.execute.bind(handler),
      }),
    ),
  );
}
export class CalcBlocked extends Error {
  constructor(
    readonly code: 'PRINCIPAL_UNAVAILABLE' | 'RULE_CACHE_STALE' | 'STORAGE_UNAVAILABLE' | 'KIND_UNAVAILABLE',
  ) {
    super(code);
  }
}
export class CalcObjectFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly levelId?: string,
    readonly rowNo?: number,
  ) {
    super(code);
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) throw new TypeError('失败仅允许错误码');
  }
}
/** §4.6：定时日期与槽序号只由 calcScheduleSlot 确定，调用方不能注入经过分钟数。 */
export function calcKey(input: CalcInput): string {
  const { kind, trigger, tenantId } = input;
  if (trigger === 'manual') return `${kind}:manual:${input.commandId}`;
  if (
    trigger === 'preferences_change' &&
    kind === 'org_stats' &&
    input.requestedBy &&
    Number.isSafeInteger(input.preferencesRevision) &&
    input.preferencesRevision! > 0
  )
    return `org_stats:preferences:${input.requestedBy}:${input.preferencesRevision}`;
  if (trigger === 'review_sync' && kind === 'org_health' && input.batchId) return `org_health:sync:${input.batchId}`;
  if (
    trigger === 'schedule' &&
    input.timezone &&
    input.now &&
    ['org_stats', 'position_risk', 'exit_sweep'].includes(kind)
  ) {
    const slot = calcScheduleSlot(input);
    const key = `${kind}:schedule:${tenantId}:${slot.businessDate}`;
    if (kind !== 'org_stats') return key;
    return `${key}:${input.intervalHours}h:${slot.slotIndex}`;
  }
  throw new TypeError('计算触发来源或幂等键参数非法');
}
