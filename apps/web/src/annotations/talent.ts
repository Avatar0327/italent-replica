import type { DecisionAnnotation } from './foundation.js';
export const talentNotes: Record<string, DecisionAnnotation> = {
  'talent-maintenance': {
    original: '人才标准可维护分类、完整指标描述、引用关系和潜力模型图。',
    decision: '保留已有维护组件和业务校验；新列表与基础抽屉使用统一底座，完整子表维护仍通过本入口。',
    decisions: ['DEC-456', 'DEC-281', 'DEC-297'],
    level: 'L3',
  },
  'talent-library': {
    original: '指标库按能力、潜力、经历分为三类，列表显示名称、类型和状态。',
    decision: '复用前端底座列表与抽屉；读取现有接口，类型建后不可修改，所属管理单元由后端确定。',
    decisions: ['DEC-456', 'DEC-281', 'DEC-294'],
    level: 'L3',
  },
  'talent-dimension': {
    original: '指标包含定义、等级描述、行为描述、发展建议和面试问题；编码建后只读。',
    decision: '列表、详情及基础字段表单接现有接口；子表按服务端可见字段展示，基础编辑不覆盖子表。',
    decisions: ['DEC-456', 'DEC-281'],
    level: 'L3',
  },
  'talent-criterion': {
    original: '人才标准详情按能力、潜力、经历、成就分栏，引用指标库当前内容。',
    decision: '展示实时引用内容；基础字段编辑保留既有指标关系，完整关系维护通过更多配置进入，课程入口后续接入。',
    decisions: ['DEC-456', 'DEC-055', 'DEC-281'],
    level: 'L3',
  },
};
