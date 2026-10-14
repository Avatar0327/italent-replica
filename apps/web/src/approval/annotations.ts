import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  approval: {
    original: '审批中心左侧分待处理、已处理和已申请，无独立面包屑；点击记录打开本单申请信息、原值与审批记录。',
    decision:
      '沿用右侧详情抽屉，页签在抽屉内；以首批截图字号与配色对齐，待处理和已申请接现有接口，操作只按详情 actions 渲染；已办使用标注的合成示例，避免将参与过的在途流程当作已办。',
    decisions: ['DEC-456', 'DEC-057', 'DEC-058'],
    level: 'L2',
  },
};
