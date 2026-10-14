import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  contracts: {
    original: '六个卡片视图、横向滚动表格、整页详情与右侧高级筛选；设置单独展示。',
    decision: '只读接口直连；缺失的筛选、排序、任职和版本链用独立演示数据。关联对象暂显示接口 ID；写操作待第二段。',
    decisions: ['DEC-456', 'DEC-476', 'DEC-482'],
    level: 'L2',
  },
};
