import { foundationNotes } from './foundation.js';
import { personnelNotes } from './personnel.js';
import { settingsNotes } from './settings.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = {
  ...foundationNotes,
  ...personnelNotes,
  ...settingsNotes,
};
export type { DecisionAnnotation } from './foundation.js';
