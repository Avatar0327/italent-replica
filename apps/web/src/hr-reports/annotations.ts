import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'hr-movement-reports': {
    original: '数据分析下的流动情况包含员工流动、各月入离职和各机构入离职等报表。',
    decision:
      '年度流动按行政组织逐层下钻。部门选择使用租户行政树，报表和下载按查看人的数据范围取数。' +
      '各月与各机构报表共用报表目录的查询和两种下载方式。',
    decisions: ['DEC-763', 'DEC-809', 'DEC-810', 'DEC-960', 'DEC-961'],
    level: 'L2',
  },
  'hr-structure-reports': {
    original: '数据分析下的员工结构含员工素质结构和员工任职结构。',
    decision:
      '两张报表支持时点、雇佣关系和部门筛选，按服务器返回的列及合计显示。' +
      '部门候选按租户行政树提供，报表按数据范围取数。素质结构支持两种下载方式。',
    decisions: ['DEC-763', 'DEC-809', 'DEC-810', 'DEC-961'],
    level: 'L2',
  },
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
