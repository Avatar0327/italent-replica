import { approvalNotes } from './approval.js';
import { establishmentNotes } from './establishment.js';
import { evaluationNotes } from './evaluation.js';
import { foundationNotes } from './foundation.js';
import { jobNotes } from './job.js';
import { orgNotes } from './org.js';
import { personnelNotes } from './personnel.js';
import { qualificationNotes } from './qualification.js';
import { selfServiceNotes } from './self-service.js';
import { settingsNotes } from './settings.js';
import { survey360Notes } from './survey360.js';
import { talentNotes } from './talent.js';
import { talentReviewNotes } from './talent-review.js';
import { transferNotes } from './transfer.js';

// 页面片在这里合并各模块注释，所有页面共用根 Provider 的全局开关。
export const annotations = {
  ...approvalNotes,
  ...establishmentNotes,
  ...evaluationNotes,
  ...foundationNotes,
  ...jobNotes,
  ...orgNotes,
  ...personnelNotes,
  ...qualificationNotes,
  ...selfServiceNotes,
  ...settingsNotes,
  ...survey360Notes,
  ...talentNotes,
  ...talentReviewNotes,
  ...transferNotes,
};
export type { DecisionAnnotation } from './foundation.js';
