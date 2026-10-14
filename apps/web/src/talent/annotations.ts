import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'talent-maintenance': {
    original: '人才标准可维护分类、完整指标描述、引用关系和潜力模型图。',
    decision: '保留已有维护组件和业务校验；新列表与基础抽屉使用统一底座，完整子表维护仍通过本入口。',
    decisions: ['DEC-456', 'DEC-281', 'DEC-297'],
    level: 'L3',
  },
  'talent-library': {
    original: 'UI/R3_人才标准/02：指标库按能力、潜力、经历分为三类，列表显示名称、类型和状态。',
    decision: '复用 FE-0 无面包屑外壳、视图标题、15 条分页和实测主题；读取现有接口，类型建后不可修改。',
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
    original: 'UI/R3_人才标准/01、04：标准列表为图标加视图名；详情按能力、潜力、经历、成就分栏。',
    decision: '按 DEC-456 修订将分栏与分区放入 FE-0 右侧详情抽屉；保留实时引用和更多配置入口，课程后续接入。',
    decisions: ['DEC-456', 'DEC-055', 'DEC-281'],
    level: 'L3',
  },
};
