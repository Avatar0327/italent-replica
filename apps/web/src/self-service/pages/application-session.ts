import { TransferApiError, requestError } from '../../transfer/api.js';
import { transferCommands, transferResult } from '../../transfer/commands.js';
import type { TransferBusiness } from '../../transfer/types.js';
import { isLocked, type Race, type Submission } from '../../foundation/forms/store.js';
import {
  ApplicationCommandHandled,
  type ApplicationCommand,
  type ApplicationCommandRunner,
} from '../shared/application-command.js';
import { messages as m } from './messages.js';

export interface ApplicationSession {
  pending: ApplicationCommand | null;
  saved: TransferBusiness | null;
  error: string;
  /** F-110：整页刷新后从恢复记录载入：只有命令 ID 与上下文，提交内容摘要未保存。 */
  restored: boolean;
  /** 结果查询进行中 / 查不到（仍处理中）。 */
  reading: boolean;
  resultPending: boolean;
  queryFailed: boolean;
  /** F-558：本次提交没有发出、锁到了别的标签页的命令上时的原因（内核 raceOf）；只对当前锁定的那条命令显示。 */
  race: string;
}
// F-110：未确认锁定交给内核（transferCommands，恢复记录各标签页共用，只存命令 ID、员工、单号、动作、生效日），
// 整页刷新、另开标签页后仍只读，只能按原命令 ID 查询结果解锁。提交内容摘要与已保存单据只在本页内存，不落存储。
const commands = new Map<string, ApplicationCommand>();
const saved = new Map<string, TransferBusiness>();
// F-558：内核只随提交结果带回竞争（不存进条目），抽屉按作用域记下最近一次，显示与否仍按当前锁定的命令判定。
const races = new Map<string, Race>();
const listeners = new Set<() => void>();
const cache = new Map<
  string,
  { state?: Submission; saved?: TransferBusiness; race?: Race; value: ApplicationSession }
>();
const contextOf = (command: ApplicationCommand) => ({
  action: command.action,
  employeeId: command.employeeId,
  effectiveDate: command.effectiveDate,
});
function pendingOf(scope: string, state: Submission): ApplicationCommand {
  const own = commands.get(scope);
  if (own?.commandId === state.command!.id) return own;
  const context = (state.context ?? {}) as Partial<ApplicationCommand>;
  return {
    commandId: state.command!.id,
    employeeId: context.employeeId ?? m.unread,
    action: context.action ?? 'submit',
    effectiveDate: context.effectiveDate,
    businessId: state.businessId,
    summary: {},
  };
}
function errorOf(state?: Submission) {
  if (state?.status !== 'rejected') return '';
  const cause = (state.error as Error | undefined)?.cause ?? state.error;
  return cause instanceof TransferApiError ? requestError(cause) : (state.error as Error).message;
}
/** useSyncExternalStore 要求快照稳定：内核状态与已保存单据都没变时返回同一对象。 */
export function readApplicationSession(scope: string): ApplicationSession {
  const state = transferCommands.get(scope);
  const known = saved.get(scope);
  const race = races.get(scope);
  const hit = cache.get(scope);
  if (hit && hit.state === state && hit.saved === known && hit.race === race) return hit.value;
  const locked = isLocked(state);
  const pending = locked ? pendingOf(scope, state!) : null;
  const value = {
    pending,
    saved: known ?? null,
    error: errorOf(state),
    restored: locked && !!state!.restored,
    reading: !!state?.reading,
    resultPending: locked && !!state!.resultPending,
    queryFailed: locked && !!state!.readError,
    race: race && pending?.commandId === race.commandId ? race.reason : '',
  };
  cache.set(scope, { state, saved: known, race, value });
  return value;
}
export function subscribeApplicationSession(listener: () => void) {
  listeners.add(listener);
  const off = transferCommands.subscribe(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}
function setRace(scope: string, race?: Race) {
  if (races.get(scope) === race) return;
  if (race) races.set(scope, race);
  else races.delete(scope);
  for (const listener of listeners) listener();
}
/**
 * 抽屉入口没有字段级冲突对照界面：确定的 4xx（含 revision 冲突）一律按被拒落定、解除处理中标记，
 * 原因由内部表单按原错误显示并重读草稿（R1d-2）；超时、断线、5xx、无效回执仍未确认。
 */
const definite = (cause: unknown) =>
  cause instanceof TransferApiError && cause.status < 500
    ? Object.assign(new Error(cause.message, { cause }), { status: 400 })
    : cause;
export async function runApplicationCommand(
  scope: string,
  command: ApplicationCommand,
  execute: Parameters<ApplicationCommandRunner>[1],
) {
  // 别页的未确认命令由内核提交判定（F-110 第 4 轮单一出口）：提交前同步与登记冲突都随结果带回竞争，本层不另外猜。
  // 上一条已确定被拒：新命令按本次动作 / 对象起算，不沿用被拒命令的上下文；锁定中的条目留给内核原样判定。
  transferCommands.sync();
  if (!isLocked(transferCommands.get(scope))) transferCommands.clear(scope);
  setRace(scope);
  commands.set(scope, command);
  let received: TransferBusiness | undefined;
  let sent = false;
  const state = await transferCommands.submit(scope, {
    values: {},
    baseline: {},
    editableFields: [],
    revision: 0,
    commandId: command.commandId,
    businessId: command.businessId,
    context: contextOf(command),
    async send() {
      sent = true;
      try {
        received = await execute();
      } catch (cause) {
        throw definite(cause);
      }
      if (!received.id || !Number.isInteger(received.revision) || !received.status) throw new Error(m.processing);
      return received;
    },
  });
  // 锁到了别的标签页的命令上：本次未发出，提示其他标签页（F-558，与 HR 页同一来源），不只显示“处理中”。
  if (state.race) {
    setRace(scope, state.race);
    throw new ApplicationCommandHandled(state.race.reason, true);
  }
  // 登记就被拒：命令未发出。前置拒绝（DEC-955）时连命令都没生成，不能按命令 ID 判成“处理中”。
  if (state.status === 'rejected' && !sent) throw new ApplicationCommandHandled(errorOf(state), true);
  if (state.command?.id !== command.commandId) throw new ApplicationCommandHandled(m.processing);
  if (state.status === 'done' && received) {
    saved.set(scope, received);
    transferCommands.clear(scope);
    return received;
  }
  const cause = (state.error as Error | undefined)?.cause;
  if (state.status === 'rejected' && cause instanceof TransferApiError) throw cause;
  throw new ApplicationCommandHandled(state.status === 'rejected' ? errorOf(state) : m.processing);
}
/** F-110：按原命令 ID 查询 F-120 结果；成功读回单据后解锁，确定失败解锁并提示，查不到 / 查询失败仍只读。 */
export async function queryApplicationResult(scope: string, tenantId: string) {
  const state = transferCommands.get(scope);
  if (state?.status !== 'unknown' || !state.command) return;
  let business: TransferBusiness | undefined;
  const result = await transferCommands.recoverResult(scope, (sent) =>
    transferResult(tenantId, sent.id, (value) => (business = value)),
  );
  if (result?.status !== 'done' || !business) return;
  saved.set(scope, business);
  transferCommands.clear(scope);
}
export function clearConfirmedApplication(scope: string) {
  const value = readApplicationSession(scope);
  if (value.pending || !value.saved || value.saved.status === 'draft') return;
  saved.delete(scope);
  commands.delete(scope);
  setRace(scope);
  transferCommands.clear(scope);
}
