import type { DecisionAnnotation } from './foundation.js';
export const orgNotes: Record<string, DecisionAnnotation> = {
  org: {
    original: '组织使用紧凑列表和架构视图，支持按生效日期查看、详情编辑和停用。',
    decision: '复用服务端多维层级与字段裁剪。树仅连接当前页可见节点；编辑仅更正设立日期，其他字段通过变更新增版本。',
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
