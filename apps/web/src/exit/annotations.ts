import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'exit-settings': {
    original:
      '组织员工设置 > 离职退休下分别维护离职类型、离职原因、离职去向；可停用，只有启用项可选（DM-R1）。表单字段截图只在本机。',
    decision:
      '三个字典各一页签，字段取名称、编码（保存后不可改）、启用、显示顺序，不提供删除；停用项照常列出并标“已停用”。' +
      '新增 / 改名 / 启停 / 调序经表单内核提交，调序只改本条显示顺序。菜单位置与列序未验证。',
    decisions: ['DEC-577', 'DEC-045', 'DEC-464', 'DEC-502'],
    level: 'L2',
  },
};
