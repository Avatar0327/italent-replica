import type { DecisionAnnotation } from '../annotations/index.js';

export const notes: Record<string, DecisionAnnotation> = {
  'hr-analytics-roster': {
    original: '数据分析下的员工名册可按时点查询和导出。',
    decision: '两个入口共用时点员工花名册。列表、筛选与 CSV 由服务端逐列授权。邮箱和雇佣关系筛选待 F-551。',
    decisions: ['DEC-763', 'DEC-960'],
    level: 'L2',
  },
};
