import type { DecisionAnnotation } from './foundation.js';
export const settingsNotes: Record<string, DecisionAnnotation> = {
  settings: {
    original: '企业设置以用户、身份授权、管理单元列表为主，标题是视图切换，无独立面包屑。数据变更日志截图为受限页。',
    decision: '复用底座列表与右侧抽屉；权限由服务端菜单决定，数据范围按用户与应用共享。审计按规格 20 展示。',
    decisions: ['DEC-456', 'DEC-043', 'DEC-019', 'DEC-056', 'DEC-470'],
    level: 'L3',
  },
  'settings.snapshot': {
    original: '企业设置入口随管理员能力变化。',
    decision: 'F-113 尚未合入，快照由现有权限菜单转接，范围摘要保持未知且不授予数据范围。',
    decisions: ['DEC-456', 'DEC-469'],
    level: 'L2',
  },
};
