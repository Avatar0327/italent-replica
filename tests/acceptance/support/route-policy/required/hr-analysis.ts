/** 必需项表：人事分析（modules/hr-analysis，BE-12a 时点员工花名册）。 */
import type { RequiredTable } from './types.js';

export const HR_ANALYSIS: RequiredTable = {
  'GET /api/tenant/hr-analysis/roster': [],
  'GET /api/tenant/hr-analysis/roster/export': [],
};
