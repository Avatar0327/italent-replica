import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'hr-reports': {
    original: '组织员工下的预置报表：员工名册分析、人事报表、员工花名册；按各报表数据权限取数。',
    decision:
      '本片展示 12 张固定报表，复用系统表格与现有接口，不仿制 Ocean iframe。' +
      '三张统计报表带「下载▾」两项（含公式 / 仅数据），能看就能导出、用页面已运行的筛选，不做订阅与打印（F-482，原站未测、按复刻口径）；' +
      '仅提供现有接口支持且可确认字段可见的筛选。',
    decisions: ['DEC-763', 'DEC-802', 'DEC-803', 'DEC-809', 'DEC-810'],
    level: 'L2',
  },
};
