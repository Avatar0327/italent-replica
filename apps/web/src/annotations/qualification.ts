import type { DecisionAnnotation } from './foundation.js';
export const qualificationNotes: Record<string, DecisionAnnotation> = {
  'qualification-category': {
    original: '任职类别按所属分类组织，可以新建或从岗职务引入。',
    decision: '基础配置调用已有接口；不建资源集合，按所属管理单元与向下公开管理。批量引入后续接入。',
    decisions: ['DEC-456', 'DEC-026', 'DEC-324'],
    level: 'L3',
  },
  'qualification-level': {
    original: '级别列表显示编码、名称、层级和顺序号，顺序号由低到高。',
    decision: '不在前端计算最大顺序号；新建省略时由服务端决定。权限未返回的字段不补全。',
    decisions: ['DEC-456', 'DEC-285'],
    level: 'L3',
  },
  'qualification-standard': {
    original: '标准列表按分类组织，点名称查看各级别的能力标准。类别和级别范围建后不能改。',
    decision: '原地修改标准基础信息，保留明细；不新增标准版本机制。图谱导出、课程和完整明细编辑后续接入。',
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
