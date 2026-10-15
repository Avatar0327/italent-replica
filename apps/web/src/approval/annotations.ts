import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  approval: {
    original:
      '我的待办左侧为搜索与待处理 / 已处理 / 已申请分类，右侧为卡片列表：待处理带复选与去处理，其余为查看详情；卡片在新标签打开详情。',
    decision:
      '按原站分类栏与卡片结构对齐；待处理和已申请接现有接口，已办仍是标注的合成示例；分类计数、搜索、批量审批无接口，保留位置禁用；详情改为当前页打开并带返回。',
    decisions: ['DEC-456', 'DEC-502', 'DEC-057'],
    level: 'L2',
  },
  'approval-detail': {
    original:
      '审批详情顶部为标题、副标题与同意 / 不同意 / 流程管理 / 查看流程日志，下方为流程进度；左侧表单页签，右侧操作记录与沟通；变更字段橙色并标原值。',
    decision:
      '按钮只按详情 actions 渲染；提交走 F-123 页面片接入 2 的命令内核，结果未知锁定、版本冲突单独提示；进度只显示已有节点，流程图、日志与沟通无接口禁用。',
    decisions: ['DEC-502', 'DEC-057', 'DEC-058', 'DEC-067'],
    level: 'L2',
  },
  'approval-applications': {
    original: '我的申请为独立表格：标题、类别、审批状态、申请时间，标题打开详情并可返回。',
    decision:
      '列序与状态文字按原站；发起人、当前处理人、申请理由与类别 / 状态筛选无接口不伪造；本会话暂存的调动申请放在表格下方。',
    decisions: ['DEC-456', 'DEC-502'],
    level: 'L2',
  },
  'approval-gap': {
    original: '我的委托、流程管理、管理员委托各有视图、右上工具栏、浅蓝提示、筛选与列表列。',
    decision: '视图、工具、提示、筛选与列序照原站；委托与流程实例接口未提供，表格为空、按钮禁用，不伪造数据。',
    decisions: ['DEC-456', 'DEC-502'],
    level: 'L2',
  },
};
