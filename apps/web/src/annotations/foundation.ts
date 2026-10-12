export interface DecisionAnnotation {
  original: string;
  decision: string;
  decisions: readonly string[];
  level: 'L1' | 'L2' | 'L3';
}
export const foundationNotes: Record<string, DecisionAnnotation> = {
  foundation: {
    original: '顶部切换应用，左侧显示业务菜单；白色工作区使用蓝色主操作与紧凑的表格、表单。',
    decision: '复刻布局与配色，使用组件库绘制控件。菜单结构和租户资料暂为演示适配，按钮与字段读取现有权限接口。',
    decisions: ['DEC-456', 'DEC-045', 'DEC-056'],
    level: 'L2',
  },
};
