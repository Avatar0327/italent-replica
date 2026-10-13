import { foundationNotes } from './foundation.js';
import { personnelNotes } from './personnel.js';
import { talentReviewNotes } from './talent-review.js';

// 页面片按模块名逐行登记，共用根 Provider 的全局开关。
export const annotations = {
  ...foundationNotes,
  ...personnelNotes,
  ...talentReviewNotes,
};
export type { DecisionAnnotation } from './foundation.js';
