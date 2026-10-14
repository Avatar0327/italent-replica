import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  org: {
    original: '第 1 批截图：无独立面包屑；左上图标与视图下拉、40px 表格；详情在右侧抽屉内分页签，编辑用双列弹窗。',
    decision:
      '按实测主题与15条分页复刻，复用多维层级及字段裁剪。树仅连当前页节点；编辑仅更正设立日期，其他字段变更新增版本。',
    decisions: ['DEC-456', 'DEC-147', 'DEC-129', 'DEC-056'],
    level: 'L3',
  },
  'org-change': {
    original: '改名或更换行政上级时，选择是否新增任职；存在在途任职时弹窗提醒。',
    decision: '复用组织变更与预检接口，保留显式任职联动选择。revision 冲突及未知结果须回查后重新打开。',
    decisions: ['DEC-137', 'DEC-067', 'DEC-456'],
    level: 'L3',
  },
};
