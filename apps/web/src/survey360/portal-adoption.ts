import { isLocked, type Submission, type Values } from '../foundation/forms/store.js';
import { changedFields, refillDraft } from '../foundation/forms/values.js';
import { sheetValues, type Answer, type AnswerPage, type Sheet } from './portal-client.js';
import { portalMessages as m } from './portal-messages.js';

/**
 * 作答页“采用哪份状态”的规则（F-397 第 5 轮，结果文件“状态采用决策表”逐格对应）。只有纯函数，不含 IO：
 * ① 基线按 revision 单调（adoptSheet）：回执、重放回执、回查、409 重读只能把确认的答卷推向更高或相等的 revision，
 *    已读到的 submitted 不退回；更低的结果只用于确认对应命令已成功，不改基线、提交状态、可编辑性与页面答卷。
 * ② 发出后是否有过编辑按编辑事件记录（Marks.edits，字段级）：发出保存时清零，之后任何输入置位；
 *    dirty = 有过发出后编辑 或 实时答卷 ≠ 确认的答卷（answerState）。
 * ③ 离开守卫 = dirty 或 有未确认命令（处理中、结果未知、冲突待核对），两者独立，任一为真即拦（leaveGuarded）。
 * ④ 打开 / 重开时只有仍有未确认命令的槽才恢复命令快照，否则以 GET 为准（restored）。
 */

/** 页面上可编辑、随保存发出的字段：整份答案、综合建议。 */
export const fields: readonly string[] = ['answers', 'suggestion'];

/** 页面答卷之外的编辑记录：存在 ref 里，异步回执后按当前值判断，不按渲染快照。 */
export interface Marks {
  /** ② 发出后有过输入的字段：发出保存时清零，之后任何输入置位；核对差异后清零（用户已逐字段核过）。 */
  edits: ReadonlySet<string>;
  /** 暂缓自动保存：冲突核对后、历史回执后为真，直到用户新输入或显式保存（F-123 §136）。 */
  held: boolean;
}

export interface Adoption {
  /** 当前确认的答卷（基线）。 */
  confirmed: AnswerPage;
  /** 回执 / 重放回执 / 回查 / 409 重读得到的答卷。 */
  next: AnswerPage;
  /** 页面实时答卷。 */
  live: Values;
  /** 保留页面值的字段：回执保留全部；回查与重读保留发出后有过编辑的字段和未确认命令改过的字段。 */
  keep: readonly string[];
}
/**
 * 唯一的采用函数（规则 ①）：advanced 为假时原样返回，调用方只据此确认命令已成功。
 * 推进时 keep 里的字段整字段保留页面值（DEC-936 本页为准，不逐题合并），其余跟随 next。
 */
export function adoptSheet({ confirmed, next, live, keep }: Adoption) {
  const { revision, status } = confirmed.sheet;
  const advanced = next.sheet.revision >= revision && (status !== 'submitted' || next.sheet.status === 'submitted');
  if (!advanced) return { advanced, page: confirmed, live };
  const values = refillDraft({ values: live, latest: sheetValues(next.sheet), edited: keep, submittable: fields });
  return { advanced, page: next, live: values };
}

/**
 * 规则 ④：槽里仍有未确认命令时，命令改过的字段按命令快照恢复（锁与重放仍以槽为准），其余字段取这次 GET；
 * 槽里已确认的结果（完成、被拒、核对后）不覆盖 GET。
 */
export function restored(sheet: Sheet, state: Submission | undefined): Values {
  const values = sheetValues(sheet);
  if (!state || !isLocked(state)) return values;
  return refillDraft({ values: state.values, latest: values, edited: state.editedFields, submittable: fields });
}

/** 槽状态、确认的答卷、实时答卷与编辑记录 → 页面状态。 */
export function answerState(state: Submission | undefined, page: AnswerPage, draft: Values, marks: Marks) {
  const operation = state?.context?.operation;
  const busy = state?.status === 'submitting';
  // 保存在途时仍可继续作答（自动保存不打断输入）；提交在途、结果未知、冲突待核对时只读。
  const saving = busy && operation === 'save';
  const submitted = page.sheet.status === 'submitted';
  const paused = !submitted && page.activity.status !== 'enabled';
  const locked = isLocked(state);
  const readonly = (locked && !saving) || submitted || paused;
  const dirty = marks.edits.size > 0 || unsaved(draft, sheetValues(page.sheet)).length > 0;
  // 已被拒的同一份草稿不再自动重发，用户改动后再保存。
  const refused = state?.status === 'rejected' && operation === 'save' && !unsaved(state.values, draft).length;
  const savable = !readonly && dirty && !busy && !refused && !marks.held;
  return { readonly, locked, submitted, paused, dirty, busy, savable };
}
export type AnswerState = ReturnType<typeof answerState>;

/** 规则 ③：刷新 / 关闭、返回列表（换活动须先返回）都按它拦截。 */
export const leaveGuarded = (state: Pick<AnswerState, 'dirty' | 'locked'>) => state.dirty || state.locked;

/** 有未确认命令时先提示确认保存结果（回查、按原命令重放仍可用），确认后才按暂停 / 已提交提示。 */
export function blockedMessage(state: AnswerState) {
  if (state.locked || (!state.paused && !state.submitted)) return m.unsavedInput;
  return state.paused ? m.pausedUnsaved : m.submittedUnsaved;
}

/** 页面 DTO 的比较口径：答案按题目排序、补充说明与综合建议去首尾空白（与服务端保存口径一致）。 */
function canonical(values: Values): Values {
  const answers = ((values.answers ?? []) as Answer[])
    .map((a) => ({ itemId: a.itemId, optionId: a.optionId, remark: (a.remark ?? '').trim() }))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
  return { answers, suggestion: String(values.suggestion ?? '').trim() };
}
/** 两份答卷不同的字段。 */
export const unsaved = (a: Values, b: Values) => changedFields(canonical(a), canonical(b), fields);
