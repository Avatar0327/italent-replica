import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'hr-reports': {
    original: '组织员工下的预置报表：员工名册分析、人事报表、员工花名册；按各报表数据权限取数。',
    decision:
      '本片展示 12 张固定报表，复用系统表格与现有接口，不仿制 Ocean iframe。' +
      '三张统计报表导出由 F-482 处理；仅提供现有接口支持且可确认字段可见的筛选。',
    decisions: ['DEC-763', 'DEC-802', 'DEC-803'],
    level: 'L2',
  },
};
