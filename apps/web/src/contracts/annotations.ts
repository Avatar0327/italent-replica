import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  contracts: {
    original: '六个卡片视图、横向滚动表格、整页详情与右侧高级筛选；设置单独展示。',
    decision:
      '列表、筛选、排序与详情（任职信息、合同信息）直连接口；新签 / 变更 / 续签 / 终止与类型 / 规则 / 设置经表单内核提交，不做合同删除；姓名 / 工号、电子签署与导出仍为演示数据。',
    decisions: ['DEC-456', 'DEC-476', 'DEC-482', 'DEC-484'],
    level: 'L2',
  },
};
