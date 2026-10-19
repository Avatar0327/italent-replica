import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'part-time': {
    original: '任职管理下的兼职管理：六视图、详情、申请历史与档案兼职记录页签。',
    decision:
      'FE-R2d1 接真实只读接口，默认兼职中、每页30条；F-255 排序后补，' +
      'F-256 缺失列保留空值，未支持筛选及列设置不展示。' +
      'FE-R2d2a 接新增预览、直接新增、编辑与批量结束，批量按钮按 DEC-642 列表级授权；三类申请待 FE-R2d2b，调动调整区待 PT-6，负责人和下属待 PT-7；' +
      '新增保存后刷新列表，是否进入详情未决；期限链操作人接口未提供，显示空值；申请链接按现有返回处理（F-254）。',
    decisions: ['DEC-476', 'DEC-595', 'DEC-625', 'DEC-634', 'DEC-642'],
    level: 'L2',
  },
};
