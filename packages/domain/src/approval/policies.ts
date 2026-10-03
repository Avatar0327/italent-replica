/**
 * 用户离开期间由编排会话按推荐代选的决策（DEC-113～119，待用户复核，`02_已确认决策.md`）。
 * 每条判断只在这里实现一次；复核结论不同时，只改本文件对应的函数和它的测试。
 * 目录与范围类的代选决策另有唯一位置：DEC-116 见 types.ts 的 APPROVAL_TYPES 与 presets.ts，
 * DEC-117 见 types.ts 的 ADD_SIGN_TYPES（不含并加签），DEC-118 见 transfer-view.ts。
 */

/** DEC-113：撤回 / 驳回后只有原发起人能重提（首版不做 HR / 代理代为重提）；当前权限复核由调用方按首次提交执行。 */
export function mayResubmit(initiatorUserId: string, actorUserId: string): boolean {
  return initiatorUserId === actorUserId;
}

/** 上一节点的一条任务（只取路由判定需要的部分）。 */
export interface PreviousNodeTask {
  /** 该节点按表达式解析出的候选人（自动跳过的节点也有）。 */
  readonly candidateUserId: string | null;
}

/**
 * DEC-114（暂定，TODO(需取证 Q-M0-43，#39)）：“与上一节点审批人相同”比较的是上一节点解析出的候选人，
 * 不是实际同意人——因此 A→A（跳过）→A 可连续跳过；跳过本身仍不计为任何人的同意（DEC-106）。
 * @param tasks 上一节点在有效历史内的任务，按序号正序
 */
export function previousNodeComparand(tasks: readonly PreviousNodeTask[]): string | null {
  return tasks.filter((task) => task.candidateUserId !== null).at(-1)?.candidateUserId ?? null;
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
