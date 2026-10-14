import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  transfer: {
    original: '调动管理无独立面包屑，采用图标与视图标题，列表每页15条、行高40；从他人调动申请打开原／新任职信息表单。',
    decision:
      '按首批截图主题与原／新布局对齐，视图下拉复用现有筛选状态；详情放右侧抽屉。沿用服务端表单配置、字段带出与联动。跨员工调动列表接口未提供，列表仅显示合成演示数据；真实提交到我的申请查询。',
    decisions: ['DEC-456', 'DEC-051', 'DEC-056'],
    level: 'L2',
  },
  'transfer-form': {
    original: '调动前后字段成对展示，按类型带出任职信息，支持暂存、提交和直接调动。',
    decision:
      '以服务端预览的字段权限和操作为准；暂存单从我的申请按当前权限读取完整草稿，未返回字段标未读取。未确认命令重开只读，不保存命令编号或跨抽屉恢复；恢复能力搁置 F-110（DEC-464）。审批通过与业务生效分开显示。',
    decisions: ['DEC-464', 'DEC-125', 'DEC-067'],
    level: 'L2',
  },
};
