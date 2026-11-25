import { useEffect, useReducer } from 'react';
import { ApiError } from '../foundation/client.js';
import type { Outcome, Submission } from '../foundation/forms/store.js';

/** 本次命令未发出（内核 refused）：前端自拟的机器码，不来自服务端（DEC-954 / DEC-955、存储不可用）。 */
export const COMMAND_NOT_SENT = 'COMMAND_NOT_SENT';

interface Peekable {
  /** 存储里当前占槽命令的状态（useCommandForm peek）。 */
  peek(): Submission | undefined;
}

/**
 * F-566（同 F-562 第 2 轮 P2-1）：提交处理中内核在返回前就发布 rejected 条目。登记冲突、而占槽命令在本页处理拒绝前
 * 已落定时，它的 error 是旧的“其他标签页”文案，详情状态区与弹窗的 CommandStatus 都不能读。
 *
 * 第 2 轮：标记放在模块级、按恢复槽的命令区分，同一存储上的各个挂载实例共用（P2-2：处理中关闭重开详情也隐去）；
 * 过期竞争只隐去提示、不清条目，已核对的版本、基线和草稿留给下一次提交（P2-1）；
 * 内核 refused 直接作为本次拒绝抛出，槽已被别页命令接管时另挂在接管条目上给详情显示（P2-3）。
 */
export function createRefusalMarks() {
  /** 本页处理中的命令 ID：它的 rejected 条目在分类完成前一律隐去。 */
  const settling = new Set<string>();
  /** 已判定为过期竞争的 rejected 条目（按对象）：条目换掉即失效。 */
  const stale = new WeakSet<Submission>();
  /** 等锁超时等 refused 时接管本槽的别页命令条目 → 本次未发出的原因；条目换掉（如查询结果落定）即失效。 */
  const notices = new WeakMap<Submission, string>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const hidden = (state: Submission) =>
    state.status === 'rejected' && ((!!state.command && settling.has(state.command.id)) || stale.has(state));

  /** 内核返回后、同一同步步骤里按当前条目分类，再解除处理中标记（避免中间渲染出旧告警）。 */
  function classify(command: Peekable, id: string | undefined, result: Outcome, issued: boolean) {
    const unsent = result.status === 'rejected' && !issued && !result.race;
    const current = command.peek();
    const own = !!id && current?.command?.id === id;
    if (unsent && result.refused && current && !own && current.command) notices.set(current, result.refused);
    if (unsent && !result.refused && own && current.status === 'rejected') stale.add(current);
    if (id) settling.delete(id);
    changed();
    return unsent;
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
     * 包住一次 command.submit：调用前后各取一次槽内状态，新起的处理中命令才登记为本页处理中。
     * submit 的 send 回调发请求前调用 issue()，据此区分“已发出被拒”与“未发出”。
     * 未发出的拒绝：带 refused 时抛出它的文案（ApiError，弹窗照原文显示）；不带时抛空值，弹窗保持打开、不提示。
     */
    async settle(command: Peekable, submit: (issue: () => void) => Promise<Outcome>): Promise<Outcome> {
      let issued = false;
      const before = command.peek();
      const pending = submit(() => {
        issued = true;
      });
      const after = command.peek();
      const id = after !== before && after?.status === 'submitting' ? after.command?.id : undefined;
      if (id) settling.add(id);
      let result: Outcome;
      try {
        result = await pending;
      } catch (cause) {
        if (id) settling.delete(id);
        changed();
        throw cause;
      }
      if (!classify(command, id, result, issued)) return result;
      if (result.refused) throw new ApiError(409, COMMAND_NOT_SENT, 'conflict', result.refused);
      throw undefined;
    },
  };
}
export type RefusalMarks = ReturnType<typeof createRefusalMarks>;

/**
 * 标记变化时让同一存储上的各挂载实例重新渲染（refused 落定后内核不再发布新条目）。
 * 只订阅本模块的标记，不订阅命令存储（命令存储只经内核 useCommandForm，AC-FE-F142）。
 * 标记只在 settle 的异步过程里变化，挂载后才订阅不会漏掉它与本次渲染之间的变化。
 */
export function useRefusalMarks(marks: RefusalMarks) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => marks.subscribe(rerender), [marks]);
}
