import type { DecisionAnnotation } from '../annotations/index.js';

export const notes: Record<string, DecisionAnnotation> = {
  'hr-analytics-roster': {
    original: '数据分析下的员工名册可按时点查询和导出。',
    decision: '两个入口共用时点员工花名册。列表、筛选与 CSV 由服务端逐列授权。邮箱和雇佣关系筛选待 F-551。',
    decisions: ['DEC-763', 'DEC-960'],
    level: 'L2',
  },
  'hr-dashboard': {
    original: '组织员工下的数据分析包含人事看板，按各看板的数据权限取数。',
    decision:
      '人事管理看板与人员结构分析按各自授权开放，统计与分页明细按回执显示。' +
      '人员结构分析使用分析专用组织候选。省份数据源待 F-549。单据类指标的适用范围见看板提示。',
    decisions: ['DEC-763', 'DEC-960', 'DEC-961', 'DEC-962', 'DEC-963'],
    level: 'L2',
  },
};
