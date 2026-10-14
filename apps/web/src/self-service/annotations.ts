import type { DecisionAnnotation } from '../annotations/index.js';

export const notes: Record<string, DecisionAnnotation> = {
  'self.profile': {
    original: '我的档案采用头像摘要、横向页签、双列字段分区及右侧分区导航。',
    decision: '复用 FE-0 主题与详情抽屉。真实档案只读，按本人接口裁剪；未接入的人员子集单独标为演示数据。',
    decisions: ['DEC-456', 'DEC-470', 'DEC-057'],
    level: 'L2',
  },
  'self.applications': {
    original: '人事申请展示任职变动列表，顶部发起本人或他人调动；我的申请为只读七列表格。',
    decision:
      '按钮读取现有权限。未确认命令在页面级只读锁定；经理暂存从原单完整读取续办，缺失字段标未读取。刷新由用户确认后主动执行。',
    decisions: ['DEC-456', 'DEC-205', 'DEC-402', 'DEC-464'],
    level: 'L2',
  },
  'manager.team': {
    original: '管理者工作台展示团队分类计数、下属档案搜索；分类打开只读成员抽屉。',
    decision: '计数、分类与字段均使用服务端结果；不由汇报关系推断组织范围，不从成员行直接调动。',
    decisions: ['DEC-456', 'DEC-206', 'DEC-057'],
    level: 'L3',
  },
  'manager.todos': {
    original: '工作台以待处理、已处理、已申请三页签展示流程信息。',
    decision: '使用经理待办接口，详情只读；办理进入审批中心。考勤、招聘、日程等配套卡片标为演示布局。',
    decisions: ['DEC-456', 'DEC-470', 'DEC-056'],
    level: 'L2',
  },
};
