import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  survey360: {
    original:
      '活动以全部、草稿、已启用、已停用页签区分；详情包含基本信息、套卷、评价关系。题库以企业自定义套卷模板列表呈现。',
    decision:
      '活动、套卷、模板、评价关系接现有接口，权限驱动操作与字段。列表按接口返回的至多 500 条分页，不捏造评价人数或进度；详情复用 FE-0 右侧抽屉。' +
      '创建结果未确认按 DEC-464 降为 L2：页面保留命令 ID、对象与摘要，重开仅可查看，不恢复或重发在途表单。',
    decisions: ['DEC-464', 'DEC-456', 'DEC-280', 'DEC-149'],
    level: 'L3',
  },
};
