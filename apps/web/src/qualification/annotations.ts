import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
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
    original: 'UI/R3_任职资格/04、07：标准按分类组织，详情按级别查看能力标准。独立指标页原站截图缺失。',
    decision:
      '按 DEC-456 修订将级别页签和能力表放入统一右侧抽屉；指标选择按规格与相邻版式实现。图谱、课程和完整明细编辑后续接入。',
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
