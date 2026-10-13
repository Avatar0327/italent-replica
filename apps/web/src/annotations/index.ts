import { approvalNotes } from './approval.js';
import { evaluationNotes } from './evaluation.js';
import { foundationNotes } from './foundation.js';
import { personnelNotes } from './personnel.js';
import { survey360Notes } from './survey360.js';
import { transferNotes } from './transfer.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = {
  ...approvalNotes,
  ...evaluationNotes,
  ...foundationNotes,
  ...personnelNotes,
  ...survey360Notes,
  ...transferNotes,
};
export type { DecisionAnnotation } from './foundation.js';
