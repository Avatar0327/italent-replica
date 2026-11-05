import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  evaluation: {
    original:
      '活动设置以名称、年度、周期、状态、所属组织、报名人数、负责人列表呈现；配置分活动信息、参评条件、活动环节三步。',
    decision:
      '复用 FE-0 表格与表单内核；评定过程、记录、评价表、评审组独立呈现，活动向导和评价表编辑采用整页。活动配置、发布、取消发布、参评名单调用现有接口。引用名称未返回时只显示标识，不补造名称；条件元数据选择器后续完善。' +
      '创建结果未确认按 DEC-464 降为 L2：页面保留命令 ID、对象与摘要，重开仅可查看，不恢复或重发在途表单。',
    decisions: ['DEC-464', 'DEC-456', 'DEC-045', 'DEC-056', 'DEC-774', 'DEC-813'],
    level: 'L3',
  },
  'evaluation-paused': {
    original: '评定过程显示阶段卡与参评人员；后续包括材料、答辩、校准、结果发布与完成活动。',
    decision:
      'DEC-456 在途 PR 收口后暂停后续 L3。本页阶段示意为独立演示数据，不模拟真实人员进度、不写入或修改评定状态。',
    decisions: ['DEC-456'],
    level: 'L2',
  },
};
