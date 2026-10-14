import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  job: {
    original: '第 1 批截图：列表用图标与视图下拉，无面包屑；详情为右侧抽屉内的页签与分区，新建用双列弹窗。',
    decision:
      '按实测12px正文、40px行高与15条分页复刻；视图仅列已授权对象。候选和写入用已有接口；非空序列变更仍异步同步任职。',
    decisions: ['DEC-456', 'DEC-040', 'DEC-127', 'DEC-208', 'DEC-218'],
    level: 'L3',
  },
};
