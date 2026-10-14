import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  establishment: {
    original: '编制方案按周期类型、维护方式和细分维度管理。',
    decision: '本页面片只读展示已有方案接口，不在前端推算编制数量、占用或缺编。',
    decisions: ['DEC-456', 'DEC-285'],
    level: 'L3',
  },
};
