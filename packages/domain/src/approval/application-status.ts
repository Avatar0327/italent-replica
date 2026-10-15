/**
 * 申请（审批实例）在员工 / 经理两侧的状态文案，唯一来源（F-141 ②，DEC-500）：
 * 员工“我的申请”接口按它回显，前端经理侧状态表引用同一份，避免“审批中 / 已退回”两边各写一份。
 */
export const APPLICATION_STATE_LABELS = {
  running: '审批中',
  returned: '已退回',
  approved: '通过',
  terminated: '已终止',
} as const;

/** 审批实例状态 → 文案：被退回单单独显示“已退回”；除进行中、通过外的终态都是“已终止”。 */
export function applicationStateLabel(state: string): string {
  if (state === 'running' || state === 'returned' || state === 'approved') return APPLICATION_STATE_LABELS[state];
  return APPLICATION_STATE_LABELS.terminated;
}
