import type { DecisionAnnotation } from './foundation.js';
export const transferNotes: Record<string, DecisionAnnotation> = {
  transfer: {
    original: '调动管理按调动中、已完成、全部记录分栏，人员与日期可筛选；从他人调动申请打开原／新任职信息表单。',
    decision:
      '沿用服务端表单配置、字段带出与联动。跨员工调动列表接口未提供，列表仅显示合成演示数据；真实提交到我的申请查询。',
    decisions: ['DEC-456', 'DEC-051', 'DEC-056'],
    level: 'L2',
  },
  'transfer-form': {
    original: '调动前后字段成对展示，按类型带出任职信息，支持暂存、提交和直接调动。',
    decision: '复用现有调动表单生命周期，以后端预览的字段权限与可用操作为准；审批通过与业务生效分开显示。',
    decisions: ['DEC-456', 'DEC-125', 'DEC-067'],
    level: 'L3',
  },
};
