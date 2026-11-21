import { TransferApiError, requestError } from '../../transfer/api.js';
import { transferCommands, transferResult } from '../../transfer/commands.js';
import type { TransferBusiness } from '../../transfer/types.js';
import { isLocked, type Submission } from '../../foundation/forms/store.js';
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
}
// F-110：未确认锁定交给内核（transferCommands，恢复记录各标签页共用，只存命令 ID、员工、单号、动作、生效日），
// 整页刷新、另开标签页后仍只读，只能按原命令 ID 查询结果解锁。提交内容摘要与已保存单据只在本页内存，不落存储。
const commands = new Map<string, ApplicationCommand>();
const saved = new Map<string, TransferBusiness>();
const cache = new Map<string, { state?: Submission; saved?: TransferBusiness; value: ApplicationSession }>();
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
  const hit = cache.get(scope);
  if (hit && hit.state === state && hit.saved === known) return hit.value;
  const locked = isLocked(state);
  const value = {
    pending: locked ? pendingOf(scope, state!) : null,
    saved: known ?? null,
    error: errorOf(state),
    restored: locked && !!state!.restored,
    reading: !!state?.reading,
    resultPending: locked && !!state!.resultPending,
    queryFailed: locked && !!state!.readError,
  };
  cache.set(scope, { state, saved: known, value });
  return value;
}
export const subscribeApplicationSession = transferCommands.subscribe;
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
  // 先对齐别的标签页的未确认命令（F-110 第 2 轮 P2-2）：别页结果未知时本页同样只读，不换新 ID 执行。
  transferCommands.sync();
  if (isLocked(transferCommands.get(scope))) throw new ApplicationCommandHandled(m.processing);
  // 上一条已确定被拒：新命令按本次动作 / 对象起算，不沿用被拒命令的上下文。
  transferCommands.clear(scope);
  commands.set(scope, command);
  let received: TransferBusiness | undefined;
  const state = await transferCommands.submit(scope, {
    values: {},
    baseline: {},
    editableFields: [],
    revision: 0,
    commandId: command.commandId,
    businessId: command.businessId,
    context: contextOf(command),
    async send() {
      try {
        received = await execute();
      } catch (cause) {
        throw definite(cause);
      }
      if (!received.id || !Number.isInteger(received.revision) || !received.status) throw new Error(m.processing);
      return received;
    },
  });
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
  transferCommands.clear(scope);
}
