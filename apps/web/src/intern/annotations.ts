import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  interns: {
    original:
      '人员信息下的实习生：实习中、实习转正中、已转正、已离职四视图；详情顶部“实习转正”“实习转正申请”“结束实习”。',
    decision:
      'FE-R2d3 接真实四视图与详情入口；入口按视图归属、单据状态与权限快照显示（读接口无逐行动作，同 F-268）。' +
      '直接转正、结束实习保存即生效，超编、在途申请先确认再以同一命令上下文重提；合同协议区与“暂存”无后端，不做；' +
      'DEC-647 实习转正申请与直接转正共用五区和试用期规则，是否有试用期必填；' +
      '申请入口暂按视图、状态及按钮权限显示，逐行动作由 F-283 后续统一接线；' +
      '“离职同步取消待入职”标未证（DEC-593）。新增实习生另拆 FE-R2d4。',
    decisions: ['DEC-473', 'DEC-486', 'DEC-593', 'DEC-625', 'DEC-647'],
    level: 'L2',
  },
};
