import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  offers: {
    original: '组织员工 > 任职管理 > Offer管理；组织员工 > 设置 > Offer管理 / 入职。列表含10个视图，点姓名打开右抽屉。',
    decision:
      'Offer列表与详情已接真实读口；名称随对应ID字段权裁剪，缺失名称显示--。查看邮件在新标签打开。' +
      '本片只接读取，写操作未接线。入口沿用任职应用服务端快照。此设置页仍是只读合成演示。',
    decisions: ['DEC-456', 'DEC-489', 'DEC-532', 'DEC-533', 'DEC-537', 'DEC-538'],
    level: 'L2',
  },
};
