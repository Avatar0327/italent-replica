import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  'talent-review-projects': {
    original: '盘点项目分进行中与已结束视图，内容页有四张看板与八个页签，无独立面包屑。',
    decision:
      '项目使用模块内整页详情与并列列表视图，保留真实项目配置及状态接口。场景、报告模板等缺字段显示 --；' +
      '关联名称契约待补，仍回显授权 ID。执行分区、校准会和人才池缺契约，标未完成，不展示演示结果。列表完整读取授权集合，最多4000条，超限报错。',
    decisions: ['DEC-456', 'DEC-056', 'DEC-774', 'DEC-812'],
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
      '盘点执行、校准会及人才池尚无对应业务接口；相关页面仅呈现已取证结构或未完成说明，不显示演示人员、计数或结果，不开放写入。F-476 在当前基线仅有设计，不当作可调用接口。',
    decisions: ['DEC-456', 'DEC-774', 'DEC-812'],
    level: 'L2',
  },
};
