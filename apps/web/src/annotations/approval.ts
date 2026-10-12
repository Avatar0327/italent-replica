import type { DecisionAnnotation } from './foundation.js';
export const approvalNotes: Record<string, DecisionAnnotation> = {
  approval: {
    original: '审批中心显示待处理、已处理和已申请，点击记录打开本单申请信息、原值与审批记录。',
    decision:
      '待办和我发起接现有接口，操作只按详情 actions 渲染；已办使用标注的合成示例，避免将参与过的在途流程当作已办。',
    decisions: ['DEC-456', 'DEC-057', 'DEC-058'],
    level: 'L2',
  },
};
