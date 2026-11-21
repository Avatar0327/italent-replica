import type { DecisionAnnotation } from '../annotations/index.js';

export const notes: Record<string, DecisionAnnotation> = {
  'hr-dashboard': {
    original: '组织员工下的数据分析包含人事看板，按各看板的数据权限取数。',
    decision:
      '本片交付人事管理看板的时点查询与分页明细，按回执呈现指标与 ID。' +
      '单据类指标按现行接口范围展示，适用范围见看板提示。',
    decisions: ['DEC-763', 'DEC-960', 'DEC-961', 'DEC-962', 'DEC-963'],
    level: 'L2',
  },
};
