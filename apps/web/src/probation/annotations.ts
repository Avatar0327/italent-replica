import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  probations: {
    original:
      '人员信息下的试用期管理：即将试用到期、考核中、转正审批中、全部试用员工、已转正五视图；' +
      '详情顶部“编辑试用期”“转正”“转正申请”，列表可批量转正（补证 B5，每页 15 条）。',
    decision:
      'FE-R2c1 接真实五视图（probation-views）与人员详情入口；入口按视图、行上的转正状态与权限快照推导' +
      '（读接口无逐行动作，同 F-268），资格由服务端判定。直接转正 / 批量转正走 /regularizations（≤100 人，' +
      '批量可不填转正日期，PB-R8），转正申请两步（建草稿 → 提交），撤回 / 撤销只对审批中的申请（PB-R15）。' +
      '除“已转正”外的列序 / 列宽未取证；考核中只读打开考核；设置页（B57～B59、试用结果字典）拆 FE-R2c1b。',
    decisions: ['DEC-473', 'DEC-524', 'DEC-625'],
    level: 'L2',
  },
};
