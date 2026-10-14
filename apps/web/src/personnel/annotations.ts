import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  personnel: {
    original: '员工列表使用紧凑表格、筛选和列设置；点击姓名打开档案，任职记录与人员信息分区展示。',
    decision: '复用 FE-0 外壳和右侧抽屉；读取已有人员接口，字段按对象权限显示，不推算总数。',
    decisions: ['DEC-456', 'DEC-045'],
    level: 'L3',
  },
  'personnel-records': {
    original: '任职按业务与生效日期展示，人员信息中的教育、工作履历等按子集分区。',
    decision: '保留后端任职版本链顺序和当前标记；日期原样显示，同日记录不合并。关联对象暂显示 ID。',
    decisions: ['DEC-056', 'DEC-108', 'DEC-456'],
    level: 'L3',
  },
  'personnel-filters': {
    original: '高级筛选从右侧打开，支持性别、部门、公司等条件；列设置调整显示字段。',
    decision: '已有精确筛选直连服务端；缺失筛选只对独立合成样例预览，列设置暂保存在页面会话内。',
    decisions: ['DEC-456'],
    level: 'L2',
  },
};
