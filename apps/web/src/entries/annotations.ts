import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  entries: {
    original: '组织员工 > 任职管理 > 入职管理；四视图、行内入职、顶部改期入职、删除气泡。',
    decision:
      '接真实待入职接口；未返回字段显示--，未接通入口禁用。编辑接F-188，取消由F-192另派。' +
      '办理入职只提交试用标记和可选合同；合同类型与生成邮箱展示为复刻补充；暂存、组织编制、二次确认未接通。',
    decisions: ['DEC-484', 'DEC-489', 'DEC-502', 'DEC-538', 'DEC-540', 'DEC-546', 'DEC-548', 'DEC-550', 'DEC-553'],
    level: 'L2',
  },
};
