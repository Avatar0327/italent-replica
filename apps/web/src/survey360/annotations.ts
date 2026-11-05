import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  survey360: {
    original:
      '活动采用状态视图与整页详情；详情依次为基本信息、套卷、评价关系、进程控制、数据筛选、个人报告、团队报告、报表。题库区分企业自定义与北森内置。',
    decision:
      'F-475：模块内组合整页与分区，活动套卷按可见评价对象关联；进程、报告、角色和活动授权接现有读取。' +
      '缺少的展示字段、内置题库与默认显示设置标未完成，不伪造数据或保存；未取证子页与操作不补造。原有表单沿用 F-123。',
    decisions: ['DEC-774', 'DEC-813', 'DEC-456', 'DEC-280', 'DEC-149'],
    level: 'L3',
  },
};
