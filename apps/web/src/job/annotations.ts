import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  job: {
    original:
      '各视图按对象定列且无操作列，点名称开详情；职位可按所属组织筛选；' +
      '职位详情分基本信息与汇报关系，职务表单编码在前，含关键 / 涉密职务。',
    decision:
      '各视图列、表单与详情分区按原站修正，引用在详情中显示名称；接口未返回的在岗人数、胜任力等不展示。' +
      '视图仅列已授权对象；非空序列变更仍异步同步任职。',
    decisions: ['DEC-456', 'DEC-040', 'DEC-127', 'DEC-208', 'DEC-218'],
    level: 'L3',
  },
};
