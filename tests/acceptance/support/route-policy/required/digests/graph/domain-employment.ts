/**
 * 直接依赖图：区域 domain-employment（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/employment/auto-regularization.ts#AUTO_REGULARIZATION_MODE_CODES': [
    '#AUTO_REGULARIZATION_MODES',
  ],
  'packages/domain/src/employment/auto-regularization.ts#AUTO_RULE_INITIATOR_CODES': ['#AUTO_RULE_INITIATORS'],
  'packages/domain/src/employment/auto-regularization.ts#autoRegularizationTargetDate': [
    'packages/domain/src/contracts/rules.ts#addDays',
  ],
  'packages/domain/src/employment/auto-regularization.ts#isAutoRegularizationDays': [
    '#AUTO_REGULARIZATION_DAYS_MAX',
    '#AUTO_REGULARIZATION_DAYS_MIN',
  ],
  'packages/domain/src/employment/blacklist.ts#BLACKLIST_REASON_CODES': ['#BLACKLIST_REASONS'],
  'packages/domain/src/employment/blacklist.ts#BLACKLIST_RULE_TERM_CODES': ['#BLACKLIST_RULE_TERMS'],
  'packages/domain/src/employment/blacklist.ts#BLACKLIST_SOURCE_CODES': ['#BLACKLIST_SOURCES'],
  'packages/domain/src/employment/blacklist.ts#blacklistBlockedMessage': ['#blacklistReasonLabel'],
  'packages/domain/src/employment/blacklist.ts#blacklistReasonLabel': ['#BLACKLIST_REASONS'],
  'packages/domain/src/employment/employee-status.ts#EMPLOYEE_STATUS_CODES': ['#EMPLOYEE_STATUS'],
  'packages/domain/src/employment/employee-status.ts#ENTRY_STATUS_CODES': ['#ENTRY_STATUS'],
  'packages/domain/src/employment/employee-status.ts#isEmployeeStatusCode': ['#EMPLOYEE_STATUS_CODES'],
  'packages/domain/src/employment/employee-status.ts#isEntryStatusCode': ['#ENTRY_STATUS_CODES'],
  'packages/domain/src/employment/entry-email.ts#EMAIL_PREFIX_FIELD_CODES': ['#EMAIL_PREFIX_FIELDS'],
  'packages/domain/src/employment/entry-email.ts#normalizeEmailDomain': ['#DOMAIN_PATTERN'],
  'packages/domain/src/employment/exit.ts#EXIT_DICTIONARY_KINDS': ['#EXIT_DICTIONARIES'],
  'packages/domain/src/employment/exit.ts#EXIT_FORM_FIELDS': ['#EXIT_REQUEST_FIELDS'],
  'packages/domain/src/employment/part-time.ts#ACTIVE_STATUSES': [
    'packages/domain/src/employment/employee-status.ts#EMPLOYEE_STATUS',
  ],
  'packages/domain/src/employment/part-time.ts#exclusivePartTimeConflict': ['#isExclusive', '#partTimeServiceStatus'],
  'packages/domain/src/employment/part-time.ts#inPartTimeView': [
    'packages/domain/src/contracts/rules.ts#addDays',
    '#PART_TIME_EXPIRING_DAYS',
    '#isEmptyPartTimeSpan',
    '#isPartTimeCurrent',
    '#partTimeServiceStatus',
  ],
  'packages/domain/src/employment/part-time.ts#isExclusive': ['#PART_TIME_EXCLUSIVE_TYPES'],
  'packages/domain/src/employment/part-time.ts#partTimeBoundaryViolation': [
    'packages/domain/src/contracts/rules.ts#addDays',
    'packages/domain/src/employment/part-time-constants.ts#PART_TIME_ERRORS',
    '#ACTIVE_STATUSES',
    '#PART_TIME_TERMINATION_KINDS',
  ],
  'packages/domain/src/employment/part-time.ts#partTimeServiceStatus': ['#isEmptyPartTimeSpan'],
  'packages/domain/src/employment/part-time.ts#partTimeViews': [
    '#PART_TIME_EXPIRING_DAYS',
    '#PART_TIME_RECORD_VIEWS',
    '#inPartTimeView',
  ],
  'packages/domain/src/employment/probation.ts#actualProbationEndDate': [
    'packages/domain/src/contracts/rules.ts#addDays',
  ],
  'packages/domain/src/employment/probation.ts#defaultRegularizationDate': [
    'packages/domain/src/contracts/rules.ts#addDays',
  ],
  'packages/domain/src/employment/probation.ts#expectedProbationEndDate': [
    'packages/domain/src/contracts/rules.ts#termEnd',
  ],
  'packages/domain/src/employment/probation.ts#normalizeProbationInfo': ['#expectedProbationEndDate'],
  'packages/domain/src/employment/probation.ts#probationAdjustmentViolation': ['#violation'],
  'packages/domain/src/employment/probation.ts#resolveDeferredProbation': ['#expectedProbationEndDate'],
};
