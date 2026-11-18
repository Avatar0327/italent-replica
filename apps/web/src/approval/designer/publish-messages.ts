// F-326 S7b 设计器发布文案（主设计 §5.5 ④⑦）；与服务端 publishProcess 的“指定人员未选择”同句。
export const p = {
  publish: '发布',
  done: '流程已发布',
  dirty: '有未保存的修改，请先保存草稿再发布',
  missing: (nodeName: string, slot: string) =>
    `节点「${nodeName}」${slot === 'empty_approver' ? '审批人为空时的' : '的'}指定人员未选择，请选择人员后再发布`,
  conflictTitle: '公共变量已在变量页修改',
  conflictHint: '以下变量在草稿期间被修改，请逐个选择发布时采用的值。',
  designerValue: '设计器值',
  currentValue: '变量页当前值',
  chooseDesigner: '采用设计器值',
  chooseCurrent: '采用变量页当前值',
  confirm: '确认发布',
  cancel: '取消',
  target: (versionNo: number) => `本次发布的目标版本：版本 ${versionNo}`,
  targetStatus: (status: string) => `该版本当前状态：${status}（仅供核对，不能据此确认本次发布结果）`,
  targetMissing: '已不是最新或生效版本',
  replay: '按原单重发',
};
