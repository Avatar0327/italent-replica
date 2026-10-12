import { foundationNotes } from './foundation.js';
import { transferNotes } from './transfer.js';
import { approvalNotes } from './approval.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = { ...foundationNotes, ...transferNotes, ...approvalNotes };
export type { DecisionAnnotation } from './foundation.js';
