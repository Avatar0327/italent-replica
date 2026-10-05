/**
 * 审批路由与披露中可能随取证或复核改变的产品判断（DEC-113～119 原为编排会话代选，2026-10-03 用户逐条复核确认；
 * DEC-124 暂定，待 Q-M0-43；F-003 会签的暂定部分待 Q-M0-57、#57 与 DEC-152 取证）。每条判断只在这里实现一次；结论
 * 改变时，只改本文件对应的函数和它的测试。
 * 目录与范围类的决策另有唯一位置：DEC-116 见 types.ts 的 APPROVAL_TYPES 与 presets.ts，DEC-117 / DEC-152 的加签类型见
 * types.ts 的 NODE_ADD_SIGN_TYPES（并加签只用于会签节点），DEC-144 的会签流转规则见 countersign.ts、出口连线去向见
 * types.ts 的 EXIT_TARGETS，DEC-118 / DEC-122 见 transfer-view.ts。
 */
import type { AddSignType, NodeExit } from './types.js';

/** DEC-113：撤回 / 驳回后只有原发起人能重提（首版不做 HR / 代理代为重提）；当前权限复核由调用方按首次提交执行。 */
export function mayResubmit(initiatorUserId: string, actorUserId: string): boolean {
  return initiatorUserId === actorUserId;
}

/** 上一节点的一条任务（只取路由判定需要的部分）。 */
export interface PreviousNodeTask {
  /** 该节点按表达式解析出的候选人（自动跳过的节点也有）。 */
  readonly candidateUserId: string | null;
  /** 会签节点合并席位时，被合并到这一席的其他表达式的候选人（F-003 第二轮 P2-4）。 */
  readonly mergedCandidateUserIds?: readonly string[];
}

/**
 * DEC-114（暂定，TODO(需取证 Q-M0-43，#39)）：“与上一节点审批人相同”比较的是上一节点解析出的候选人，
 * 不是实际同意人——因此 A→A（跳过）→A 可连续跳过；跳过本身仍不计为任何人的同意（DEC-106）。
 * F-003：上一节点是会签时，它逐人解析出多个候选人，与其中任一人相同即算相同（单人节点只有一个，口径不变）；
 * 两个表达式落到同一接手人、合并为一席时，被合并的候选人同样计入，与仿真一致。
 * @param tasks 上一节点在有效历史内的任务，按序号正序
 * @returns 候选人，按出现先后去重
 */
export function previousNodeComparand(tasks: readonly PreviousNodeTask[]): string[] {
  const candidates = tasks.flatMap((task) => [
    ...(task.candidateUserId === null ? [] : [task.candidateUserId]),
    ...(task.mergedCandidateUserIds ?? []),
  ]);
  return [...new Set(candidates)];
}

/**
 * DEC-124（暂定，TODO(需取证 Q-M0-43，#39)）：“历史审批人相同”只计算本轮的有效同意——驳回或撤回后重提开启
 * 新一轮，上一轮的同意不参与自动处理；本轮内管理员干预 / 跳转之后，边界之前的任务也不再算历史（F7，`14` §11.6）。
 * “与上一节点相同”的比较对象同样只在有效历史内取。
 */
export function effectiveHistory<T extends { readonly round: number; readonly seq: number }>(
  tasks: readonly T[],
  instance: { readonly round: number; readonly historyFromSeq: number },
): T[] {
  return tasks.filter((task) => task.round === instance.round && task.seq >= instance.historyFromSeq);
}

/** 查看人与本单的关系（记录隐藏判定用）。 */
export interface RecordViewer {
  /** 查看人作为审批人参与过的每个节点是否勾选了「审批记录查看权限」（DEC-104）。 */
  readonly participatedNodeHides: readonly boolean[];
  readonly isInitiator: boolean;
  /** 开始节点是否勾选（对发起人生效）。 */
  readonly hideFromInitiator: boolean;
}

/**
 * DEC-115：严格隐藏——一人参与多个节点时，任一参与节点开启即隐藏（默认拒绝）；发起人按开始节点的开关。
 * 被隐藏方看不到审批记录与沟通，包括本人已处理的历史（visibleWhenHidden）。
 */
export function recordsHiddenFor(viewer: RecordViewer): boolean {
  return viewer.participatedNodeHides.some(Boolean) || (viewer.isInitiator && viewer.hideFromInitiator);
}

/** DEC-115：记录被隐藏时 PC 端只保留当前待办（当前处理人，尚无意见）；原站移动端另行隐藏当前人（`14` §11.9）。 */
export function visibleWhenHidden(task: { readonly status: string }): boolean {
  return task.status === 'pending';
}

/**
 * DEC-119：盲审只看审批人对本单变化字段的查看权（DEC-058 原文），节点表单白名单不参与盲审拦截。
 * @returns 查看人看不到的变化字段；不受字段权限约束（viewable 为 undefined）时为空
 */
export function blindReviewFields(
  changedFields: readonly string[],
  viewable: ReadonlySet<string> | undefined,
): string[] {
  return viewable === undefined ? [] : changedFields.filter((field) => !viewable.has(field));
}

/** DEC-119：日志与详情里出现的字段名按“节点表单 + 字段查看权”共同过滤（DEC-057 最小披露）。 */
export function disclosedFieldNames(
  nodeFormFields: readonly string[],
  viewable: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  return new Set(nodeFormFields.filter((field) => viewable === undefined || viewable.has(field)));
}

/**
 * DEC-144 中的暂定部分（Q-M0-57 🟡，TODO(需取证 Q-M0-57，#56)）：会签节点沿某个出口动作流转后，其余未处理的待办
 * 自动结束，并记明原因。驳回不进流转规则：任一人驳回即整单驳回，在办任务与单人节点驳回一样取消。
 */
export function countersignEndedReason(exit: NodeExit): string {
  return exit === 'approve' ? '因节点已通过而结束' : '因节点已按不同意流转而结束';
}

/**
 * 暂定（TODO(需取证 #57)）：自定义审批方式下，本节点已没有在办任务、仍没有出口动作达到其规则（如两人一同意一不同意、
 * 或整数大于实际人数）时，按不通过处理（fail-closed）：退回发起人、可修改重提，不让流程停在无人可办的节点。
 * 与「不同意」达标的去向（连到结束，EXIT_TARGETS）不同：这里没有任何动作达到规则，不能当作沿哪条连线流转。
 */
export const STALLED_COUNTERSIGN_HANDLING = 'return' as const;

/**
 * DEC-152 暂定（原站会签节点前加签的细节未实测，TODO(需取证 DEC-152)）：会签节点上，并加签人与原审批人各计一票、
 * 计入流转规则；前加签人不计入——被加签人先审，同意后回到原席位审批人，这一席仍由原审批人投票。前加签人因此不能点
 * 出口动作「不同意」，只能同意或（节点开了驳回时）驳回；嵌套加签仍拒绝。
 */
export function addSignerVotes(type: AddSignType): boolean {
  return type === 'parallel';
}
