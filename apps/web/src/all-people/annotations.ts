import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'all-people': {
    original:
      '组织员工 → 人员信息 → 全部人员：筛选员工、姓名、用工形式、雇佣关系、邮箱、任职类型（默认主职）、人员状态（默认试用、正式）；' +
      '列为复选、姓名、邮箱、工号、一至三级组织、部门、职级、职位、直线经理、入职日期、司龄、性别、证件类型、证件号码、年龄、齿轮；' +
      '工具有批量下载附件、导出数据（每页 15 条）。',
    decision:
      'F-474-4c 接只读分页接口 GET /employment/all-people：入口按任职记录对象的查看权，数据范围与人员侧字段权沿用员工档案，' +
      '列以接口返回的 columns 为准（无字段权的列整列缺席），筛选字段不可见则不带该筛选。批量下载附件、导出数据、齿轮列设置、' +
      '高级筛选内容、表头排序、行点击、空状态在原站均未验证，不实现；任职类型本列表只含主职（兼职 / 借调 / 外派后补）。',
    decisions: ['DEC-776', 'DEC-833', 'DEC-836'],
    level: 'L2',
  },
};
