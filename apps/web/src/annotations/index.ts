import { foundationNotes } from './foundation.js';
import { orgNotes } from './org.js';
import { jobNotes } from './job.js';
import { establishmentNotes } from './establishment.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = { ...foundationNotes, ...orgNotes, ...jobNotes, ...establishmentNotes };
export type { DecisionAnnotation } from './foundation.js';
