import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'qualification-target': {
    original: '指标列表按类型组织，包含名称、编码、类型、说明、顺序和状态。',
    decision: '读取现有指标契约；筛选内部未验证，保留禁用呈现，不推断交互。',
    decisions: ['DEC-774', 'DEC-456'],
    level: 'L3',
  },
  'qualification-grade-scheme': {
    original: '等级方案列表显示名称和描述，编辑分为方案信息与等级明细。',
    decision: '表单复用 F-123 内核，保留明细 ID，以真实接口保存；不推断新增等级默认值。',
    decisions: ['DEC-774', 'DEC-456'],
    level: 'L3',
  },
  'qualification-category-class': {
    original: 'UI/R3_任职资格/01：类别按分类组织；分类维护页的列与操作原站证据不足（未验证）。',
    decision:
      '按后端分类契约补维护入口：列表、新建、编辑，复用同套目录页与表单弹窗；上级分类建后不可改，层级由服务端推出。',
    decisions: ['DEC-500', 'DEC-456'],
    level: 'L3',
  },
  'qualification-category': {
    original: 'UI/R3_任职资格/01、08：类别按分类组织，编辑为双列居中弹窗，可以新建或从岗职务引入。',
    decision: '复用 FE-0 双列表单弹窗与同套实测主题；按所属管理单元与向下公开管理，批量引入后续接入。',
    decisions: ['DEC-456', 'DEC-026', 'DEC-324'],
    level: 'L3',
  },
  'qualification-level': {
    original: 'UI/R3_任职资格/02：级别列表显示编码、名称、层级和顺序号，默认每页 15 条。',
    decision: '不在前端计算最大顺序号；新建省略时由服务端决定。权限未返回的字段不补全。',
    decisions: ['DEC-456', 'DEC-285'],
    level: 'L3',
  },
  'qualification-standard': {
    original: 'UI/R3_任职资格/04、07：标准按分类组织，详情按级别查看能力标准；指标列表按类型组织。',
    decision: '按 DEC-774 将级别导航和能力表放入模块内整页，保留两层目标与权重；缺契约的生效日期留空。',
    decisions: ['DEC-456', 'DEC-055', 'DEC-026'],
    level: 'L3',
  },
  'qualification-channel': {
    original: '员工通道显示当前级别、纵向晋升和横向发展路径；无资格时显示空态。',
    decision: '本页为管理端员工入口，选人后按现有接口返回展示路径、业务日期和级别标准，前端不推导资格。',
    decisions: ['DEC-456', 'DEC-352', 'DEC-056'],
    level: 'L3',
  },
};
