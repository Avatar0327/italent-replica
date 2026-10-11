/** B3a / DEC-427：可信的模块内端口，不是 HTTP 授权入口。A3/C1/B4/B5 只追加 kind 实例。 */
import { CALC_KINDS, type Tx, type successionCalcRuns, type successionCalcRunObjects } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';

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
  return Object.freeze(handlers.map((handler) => Object.freeze({ ...handler })));
}
/** A3 的 exit_sweep/employee、C1 的 org_stats/org、B4/B5 的 position/org 在此追加模块级实例。 */
export const SUCCESSION_CALC_KINDS = defineCalcKinds([]);

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
/** §4.6：统计槽的 elapsedMinutes 必须来自数据库的租户午夜时间差，不能用钟面小时代替。 */
export function calcKey(input: CalcInput, elapsedMinutes?: number): string {
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
    const date = tenantLocalDate(input.now, input.timezone);
    const key = `${kind}:schedule:${tenantId}:${date}`;
    if (kind !== 'org_stats') return key;
    const h = input.intervalHours;
    if (!Number.isInteger(h) || h! < 1 || h! > 24) throw new TypeError('统计间隔必须为 1～24 小时');
    if (!Number.isSafeInteger(elapsedMinutes) || elapsedMinutes! < 0) throw new TypeError('缺少租户午夜起算分钟数');
    return `${key}:${h}h:${Math.floor(elapsedMinutes! / (h! * 60))}`;
  }
  throw new TypeError('计算触发来源或幂等键参数非法');
}
