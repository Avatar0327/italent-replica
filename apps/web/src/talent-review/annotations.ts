import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'talent-review-projects': {
    original: '盘点项目分进行中与已结束视图，内容页有四张看板与八个页签，无独立面包屑。',
    decision:
      '按派发补充使用 FE-0 右侧详情抽屉；主题沿用原站实测。项目配置与状态接现有接口，场景和报告模板缺少字段时显示 --。关联名称接口待补，真实关联暂回显 ID。列表完整读取授权结果后筛选，最多4000条，超限报错。',
    decisions: ['DEC-456', 'DEC-056'],
    level: 'L2',
  },
  'talent-review-templates': {
    original: '模板按基本信息、模块设置、步骤权限组织配置。',
    decision:
      '基础信息使用现有接口；模块与权限按服务端当前版本只读展示，不用表单默认值覆盖结构。原站模板截图缺失，采用相邻配置页与 FE-0 表单版式。',
    decisions: ['DEC-456'],
    level: 'L2',
  },
  'talent-review-matrices': {
    original: '九宫格配置列表；详情按轴分段、格子名称与比例规则展示。',
    decision: '读取真实九宫格配置，格子按后端横纵轴顺序预览；不计算人员落位，不推断原站未验证的拖拽行为。',
    decisions: ['DEC-456'],
    level: 'L2',
  },
  'talent-review-demo': {
    original: '详情包括盘点对象、多人评价关系、指标明细、九宫格、两种继任地图、仪表盘与结果审批流程；校准会独立列表。',
    decision:
      'PR-C / PR-D 按 DEC-456② 暂停。用集中演示桩呈现独立合成样例，标明演示数据，暂停计算、校准写入、审批及跨模块动作。地图交 FE-R3d，不把未验证 Canvas 内容当产品行为。',
    decisions: ['DEC-456'],
    level: 'L2',
  },
};
