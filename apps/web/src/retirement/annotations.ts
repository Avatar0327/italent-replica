import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  retirements: {
    original:
      '人员信息下的退休管理：即将退休、过期未退休、退休中、已完成的退休、全部退休记录五视图（B16～B20）；' +
      '意向退休日期申请（B21）、退休办理（B22，含职责转交）、退休申请（B23）、退休交接（B24）。',
    decision:
      'FE-R2c3 接五视图（按 view 读后端投影，列序 / 列宽未验证）与详情入口；入口按视图归属、单据状态与权限快照显示' +
      '（读接口无逐行动作，同 F-268）。办理 / 申请先预览，阻断项禁止提交，在途调动 / 考核令牌随单提交，' +
      '服务端仍要求确认时以同一命令上下文重提；撤销超编确认同理。退休交接子流程后端未开放，页签只显示缺口；' +
      '“同时返聘”、编辑 / 改期 / 改撤销原因与 B66 / B67 拆 FE-R2c3b。',
    decisions: ['DEC-473', 'DEC-625', 'DEC-703'],
    level: 'L2',
  },
};
