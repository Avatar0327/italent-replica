import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  transfer: {
    original:
      '调动管理为横向三个视图（调动中员工 / 已完成的调动 / 全部调动记录），右上工具栏，视图下有可收起的浅蓝提示；他人调动申请与调动在当前页打开全页表单。',
    decision:
      '视图、工具顺序、提示、筛选与列序按原站；无接口的工具保留位置禁用。跨员工调动列表接口未提供，列表仅显示合成演示数据；真实提交到我的申请查询。',
    decisions: ['DEC-456', 'DEC-051', 'DEC-056'],
    level: 'L2',
  },
  'transfer-form': {
    original: '调动前后字段成对展示，按类型带出任职信息，支持暂存、提交和直接调动。',
    decision:
      '以服务端预览的字段权限和操作为准；他人调动申请暂存按人一份，本会话内重选同一人按当前权限读取草稿自动带出，' +
      '可点击清除，不列暂存单（DEC-511）。未确认命令重开只读，不保存命令编号；恢复能力搁置 F-110（DEC-464）。' +
      '审批通过与业务生效分开显示。',
    decisions: ['DEC-511', 'DEC-464', 'DEC-125', 'DEC-067'],
    level: 'L2',
  },
};
