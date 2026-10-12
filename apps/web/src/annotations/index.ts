import { talentNotes } from './talent.js';
import { qualificationNotes } from './qualification.js';
import { foundationNotes } from './foundation.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = { ...foundationNotes, ...talentNotes, ...qualificationNotes };
export type { DecisionAnnotation } from './foundation.js';
