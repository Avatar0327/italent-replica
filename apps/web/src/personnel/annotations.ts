import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  personnel: {
    original:
      '员工列表使用紧凑表格与高级筛选，表头右侧齿轮进入“设置显示字段”；点击姓名从右侧打开档案，' +
      '分“人员信息”“任职记录”两个页签。',
    decision: '复用 FE-0 外壳和右侧抽屉；读取已有人员接口，字段按对象权限显示，不推算总数。',
    decisions: ['DEC-456', 'DEC-045'],
    level: 'L3',
  },
  'personnel-records': {
    original:
      '人员信息纵向排列基本信息与教育、工作履历等子集，右侧档案导航定位；任职记录逐条卡片展示“开始 至 结束”，' +
      '当前记录标“生效中”。',
    decision: '保留后端任职版本链顺序和当前标记；日期原样显示，同日记录不合并。关联对象暂显示 ID。',
    decisions: ['DEC-056', 'DEC-108', 'DEC-456'],
    level: 'L3',
  },
  'personnel-filters': {
    original: '高级筛选从右侧打开，支持性别、部门、公司等条件；设置显示字段为居中双栏弹窗，可拖拽排序、恢复默认。',
    decision: '已有精确筛选直连服务端；缺失筛选只对独立合成样例预览，列设置暂保存在页面会话内。',
    decisions: ['DEC-456'],
    level: 'L2',
  },
};
