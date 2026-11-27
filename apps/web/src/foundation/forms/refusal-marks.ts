import { useEffect, useReducer } from 'react';
import { ApiError } from '../client.js';
import type { Outcome, Submission } from './store.js';

/** 本次命令未发出（内核 refused）：前端自拟的机器码，不来自服务端（DEC-954 / DEC-955、存储不可用）。 */
export const COMMAND_NOT_SENT = 'COMMAND_NOT_SENT';

interface Peekable {
  /** 存储里当前占槽命令的状态（useCommandForm peek）。 */
  peek(): Submission | undefined;
}
interface Clearable extends Peekable {
  clear(): void;
}
type Submit = (issue: () => void) => Promise<Outcome>;

/**
 * 本次拒绝的提示标记（F-571 收进内核；审批、组织调整、HR 调动共用这一份口径）。
 * F-566（同 F-562 第 2 轮 P2-1）：提交处理中内核在返回前就发布 rejected 条目。登记冲突、而占槽命令在本页处理拒绝前
 * 已落定时，它的 error 是旧的“其他标签页”文案，状态区（CommandStatus）不能读。
 *
 * 第 2 轮：标记放在模块级、按恢复槽的命令区分，同一存储上的各个挂载实例共用（P2-2：处理中关闭重开详情也隐去）；
 * 过期竞争只隐去提示、不清条目，已核对的版本、基线和草稿留给下一次提交（P2-1）；
 * 内核 refused 直接作为本次拒绝抛出，槽已被别页命令接管时另挂在接管条目上给详情显示（P2-3）。
 * 第 3 轮：过期竞争按命令记（第 4 轮改按命令对象、随命令回收），内核裁剪字段复制条目（settledState）后仍隐去（P2-5）；
 * 新读回的记录版本高于过期条目时清掉它，提交以新记录为基线、版本（P2-4）。
 * 两个入口：settle（审批、组织调整：条目留着，未发出的拒绝抛给弹窗）；attempt（HR 调动：提示走表单原位置，
 * 处理函数里自己清槽，见 attempt 注释）。
 */
export function createRefusalMarks() {
  /** 本页处理中的命令 ID：它的 rejected 条目在分类完成前一律隐去。 */
  const settling = new Set<string>();
  /** attempt 入口：本次 submit 同步落下、不带命令的拒绝条目（DEC-955 等），处理函数跑完之前隐去。 */
  const attempting = new WeakSet<Submission>();
  /**
   * 已判定为过期竞争的命令（按命令对象）：内核复制条目（字段裁剪 settledState、同 ID 同步）时沿用同一命令对象，
   * 标记仍生效；重提会换新命令。命令离槽（清槽、成功重提）后随旧命令回收，不留到页面刷新（第 4 轮 P3）。
   */
  const stale = new WeakSet<NonNullable<Submission['command']>>();
  /** 等锁超时等 refused 时接管本槽的别页命令条目 → 本次未发出的原因；条目换掉（如查询结果落定）即失效。 */
  const notices = new WeakMap<Submission, string>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const hidden = (state: Submission) =>
    state.status === 'rejected' &&
    (attempting.has(state) || (!!state.command && (settling.has(state.command.id) || stale.has(state.command))));

  /** 内核返回后按当前条目分类（过期竞争、接管条目的原因），返回本次是否未发出。 */
  function classify(command: Peekable, id: string | undefined, result: Outcome, issued: boolean) {
    const unsent = result.status === 'rejected' && !issued && !result.race;
    const current = command.peek();
    const own = !!id && current?.command?.id === id;
    if (unsent && result.refused && current && !own && current.command) notices.set(current, result.refused);
    const sent = own && current.status === 'rejected' ? current.command : undefined;
    if (unsent && !result.refused && sent) stale.add(sent);
    return unsent;
  }

  /**
   * 包住一次 command.submit：调用前后各取一次槽内状态，新起的处理中命令才登记为本页处理中。
   * submit 的 send 回调发请求前调用 issue()，据此区分“已发出被拒”与“未发出”。
   * handle 在分类之后、解除处理中标记之前的同一同步步骤里执行（避免中间渲染出旧告警），之后通知各挂载实例重绘。
   */
  async function run<T>(
    command: Peekable,
    submit: Submit,
    handle: (result: Outcome, unsent: boolean) => T,
    early: boolean,
  ): Promise<T> {
    let issued = false;
    const before = command.peek();
    const pending = submit(() => {
      issued = true;
    });
    const after = command.peek();
    const fresh = after !== before ? after : undefined;
    const id = fresh?.status === 'submitting' ? fresh.command?.id : undefined;
    const instant = early && fresh?.status === 'rejected' ? fresh : undefined;
    if (id) settling.add(id);
    if (instant) attempting.add(instant);
    try {
      const result = await pending;
      return handle(result, classify(command, id, result, issued));
    } finally {
      if (id) settling.delete(id);
      if (instant) attempting.delete(instant);
      changed();
    }
  }

  return {
    subscribe,
    /** 给 CommandStatus 的状态：隐去的 rejected 显示为空闲，草稿、基线、最新记录引用不变（表单回填照常）。 */
    view(state: Submission | undefined): Submission | undefined {
      return state && hidden(state) ? { ...state, status: 'idle', error: undefined } : state;
    },
    /** 槽被别页命令接管时本次未发出的原因（只在接管条目仍是当前条目时有值）。 */
    notice: (state: Submission | undefined) => (state ? notices.get(state) : undefined),
    /**
     * 新读回的记录（详情重开、刷新）版本高于过期竞争条目时清掉它：过期条目的版本、基线和草稿都已被取代，
     * 不能再带进提交（P2-4）。同一弹窗里重读核对过的条目版本不低于记录，照旧保留（P2-1）；其他条目不动。
     */
    supersede(command: Clearable, revision: number | undefined) {
      const state = command.peek();
      const sent = state?.command;
      if (!state || !sent || state.status !== 'rejected' || !stale.has(sent)) return;
      if (revision === undefined || revision <= state.revision) return;
      stale.delete(sent);
      command.clear();
    },
    /**
     * 审批、组织调整：被拒条目留在槽里（过期竞争只隐去提示）。
     * 未发出的拒绝：带 refused 时抛出它的文案（ApiError，弹窗照原文显示）；不带时抛空值，弹窗保持打开、不提示。
     */
    settle(command: Peekable, submit: Submit): Promise<Outcome> {
      return run(
        command,
        submit,
        (result, unsent) => {
          if (!unsent) return result;
          if (result.refused) throw new ApiError(409, COMMAND_NOT_SENT, 'conflict', result.refused);
          throw undefined;
        },
        false,
      );
    },
    /**
     * HR 调动（F-562）：本次拒绝的提示只走表单原位置或“处理中”，状态区不读本次任何被拒条目。
     * 除本次命令外，同步落下的未带命令拒绝（DEC-955 等）也隐去；handle 处理完结果（提示、清槽）才解除，
     * 处理之后仍留在槽里的 rejected（如主动查询结果确认失败）照常显示。
     */
    attempt<T>(command: Peekable, submit: Submit, handle: (result: Outcome, unsent: boolean) => T): Promise<T> {
      return run(command, submit, handle, true);
    },
  };
}
export type RefusalMarks = ReturnType<typeof createRefusalMarks>;

/**
 * 标记变化时让同一存储上的各挂载实例重新渲染（refused 落定后内核不再发布新条目）。
 * 只订阅本模块的标记，不订阅命令存储（命令存储只经内核 useCommandForm，AC-FE-F142）。
 * 标记只在 settle / attempt 的异步过程里变化，挂载后才订阅不会漏掉它与本次渲染之间的变化。
 */
export function useRefusalMarks(marks: RefusalMarks) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => marks.subscribe(rerender), [marks]);
}
