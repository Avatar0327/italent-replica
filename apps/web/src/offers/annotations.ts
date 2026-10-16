import type { DecisionAnnotation } from '../annotations/index.js';
export const notes: Record<string, DecisionAnnotation> = {
  offers: {
    original: '组织员工 > 任职管理 > Offer管理；组织员工 > 设置 > Offer管理 / 入职。列表含10个视图，点姓名打开右抽屉。',
    decision:
      'BE-14未接线：本入口借用任职应用EmploymentRecord入口对象，仍由服务端快照控制菜单。全部为合成演示数据，确认弹窗不调用接口、不改变状态；' +
      '其他动作禁用。Offer.StatusTransfer与OfferLineOpStatusTransfer真实权限待BE-14接入；' +
      '演示按钮只按状态显示。待发与已接受转移候选、待发失效执行和全部视图其他状态菜单尚未验证。设置只读；' +
      '当前值按本机截图，未知显示--。',
    decisions: ['DEC-456', 'DEC-489', 'DEC-532', 'DEC-533', 'DEC-537', 'DEC-538'],
    level: 'L2',
  },
};
