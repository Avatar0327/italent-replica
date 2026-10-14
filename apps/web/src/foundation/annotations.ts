import type { DecisionAnnotation } from '../annotations/index.js';

export const notes: Record<string, DecisionAnnotation> = {
  foundation: {
    original: '顶部切换应用，左侧菜单可收起；列表用图标与视图下拉，无独立面包屑，详情从右侧抽屉打开。',
    decision: '按第 1 批实测对齐颜色和尺寸，使用组件库绘制控件。菜单结构与租户资料为演示适配，权限读取现有接口。',
    decisions: ['DEC-456', 'DEC-045', 'DEC-056'],
    level: 'L2',
  },
};
