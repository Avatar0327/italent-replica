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
  /**
   * F-558 P2-3：按原命令 ID 查到成功，但无法确认是本页发出的命令（别的标签页、复制标签页等）：只展示结果，
   * 不记成本页已保存，本页输入另行保留，是否再提交由用户核对后决定（第 3 轮起提示中性，不声称本页未提交）。
   */
  found: TransferBusiness | null;
}
// F-110：未确认锁定交给内核（transferCommands，恢复记录各标签页共用，只存命令 ID、员工、单号、动作、生效日），
// 整页刷新、另开标签页后仍只读，只能按原命令 ID 查询结果解锁。提交内容摘要与已保存单据只在本页内存，不落存储。
const commands = new Map<string, ApplicationCommand>();
const saved = new Map<string, TransferBusiness>();
/**
 * F-558 第 3 轮 P2-3：本页内存里的已发出证据（实际调用过发送的命令 ID）。只在本页模块实例里：
 * 整页刷新会丢、复制标签页不会带过去，会话存储写失败也不影响。结果未知时留着，供回查出口判定归属。
 */
const sentHere = new Set<string>();
/**
 * F-558：本次操作的结果，按作用域记最近一次（下次提交时清掉）。内核只随提交结果带回竞争与普通拒绝（不存进条目）：
 * race 显示与否仍按当前锁定的命令判定；refused 是本次未发出的普通拒绝，留在表单提示区（第 2 轮 P2-1）；
 * found 是查到的别页命令结果（第 2 轮 P2-3）。
 */
interface Note {
  race?: Race;
  refused?: string;
  found?: TransferBusiness;
}
const notes = new Map<string, Note>();
const listeners = new Set<() => void>();
const cache = new Map<
  string,
  { state?: Submission; saved?: TransferBusiness; note?: Note; value: ApplicationSession }
>();
// F-558 第 2 轮 P2-3：本标签页发起过的命令 ID（会话存储随整页刷新保留；只存 ID，不存内容）。第 3 轮起只在没有
// 内存证据时（整页刷新后）兜底判归属，保住 F110-08 / F110-11 刷新后查回成功的正例；复制标签页会克隆会话存储，
// 这条兜底是否保留待总编排决定（见 PR 未决）。
const ISSUED = 'italent.self-service.issued-commands';
const ISSUED_LIMIT = 20;
function issuedHere(): string[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(ISSUED) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function markIssued(commandId: string) {
  try {
    sessionStorage.setItem(ISSUED, JSON.stringify([...issuedHere(), commandId].slice(-ISSUED_LIMIT)));
  } catch {
    // 写不进时：本页不刷新仍按内存证据判归属；刷新后归属无法确认，只展示结果、保留输入，提示中性。
  }
}
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
  const note = notes.get(scope);
  const hit = cache.get(scope);
  if (hit && hit.state === state && hit.saved === known && hit.note === note) return hit.value;
  const locked = isLocked(state);
  const pending = locked ? pendingOf(scope, state!) : null;
  const value = {
    pending,
    saved: known ?? null,
    error: note?.refused ?? errorOf(state),
    restored: locked && !!state!.restored,
    reading: !!state?.reading,
    resultPending: locked && !!state!.resultPending,
    queryFailed: locked && !!state!.readError,
    race: note?.race && pending?.commandId === note.race.commandId ? note.race.reason : '',
    found: (!pending && note?.found) || null,
  };
  cache.set(scope, { state, saved: known, note, value });
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
function setNote(scope: string, note?: Note) {
  if (!notes.has(scope) && !note) return;
  if (note) notes.set(scope, note);
  else notes.delete(scope);
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
  setNote(scope);
  commands.set(scope, command);
  markIssued(command.commandId);
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
      sentHere.add(command.commandId);
      try {
        received = await execute();
      } catch (cause) {
        throw definite(cause);
      }
      if (!received.id || !Number.isInteger(received.revision) || !received.status) throw new Error(m.processing);
      return received;
    },
  });
  if (state.status !== 'unknown') sentHere.delete(command.commandId);
  // 锁到了别的标签页的命令上：本次未发出，提示其他标签页（F-558，与 HR 页同一来源），不只显示“处理中”。
  if (state.race) {
    setNote(scope, { race: state.race });
    throw new ApplicationCommandHandled(state.race.reason, true);
  }
  // 登记就被拒：命令未发出。前置拒绝（DEC-955）时连命令都没生成，不能按命令 ID 判成“处理中”。
  // 普通拒绝（内核 refused）记为本次操作的提示，落定时同步接管了别页命令、之后别页落定，回到表单仍在（第 2 轮 P2-1）；
  // 登记冲突但占槽命令已落定（没有 race）不提示其他标签页。被拒的条目不留，提示只取本次操作的结果。
  if (state.status === 'rejected' && !sent) {
    setNote(scope, state.refused ? { refused: state.refused } : undefined);
    transferCommands.clear(scope);
    throw new ApplicationCommandHandled(state.refused ?? errorOf(state), true);
  }
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
  // 第 3 轮 P2-3：归属在这一个出口判定，先认本页内存里的已发出证据；没有内存证据时按会话存储兜底（整页刷新）。
  // 归属无法确认（别的标签页、会话存储写失败后刷新）只展示结果、保留本页输入，提示中性，不声称本页未提交。
  const own = sentHere.has(state.command.id) || issuedHere().includes(state.command.id);
  if (result && result.status !== 'unknown') sentHere.delete(state.command.id);
  if (result?.status !== 'done' || !business) return;
  if (own) saved.set(scope, business);
  else setNote(scope, { found: business });
  transferCommands.clear(scope);
}
export function clearConfirmedApplication(scope: string) {
  const value = readApplicationSession(scope);
  if (value.pending || !value.saved || value.saved.status === 'draft') return;
  saved.delete(scope);
  commands.delete(scope);
  setNote(scope);
  transferCommands.clear(scope);
}
