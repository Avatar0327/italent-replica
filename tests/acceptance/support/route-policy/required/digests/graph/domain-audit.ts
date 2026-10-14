/**
 * 直接依赖图：区域 domain-audit（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/audit/changes.ts#auditOperationOf': ['#CREATE_VERBS', '#DELETE_VERBS', '#isNothing'],
  'packages/domain/src/audit/changes.ts#diffAuditFields': [
    '#TECHNICAL_FIELDS',
    '#flatten',
    '#lastSegment',
    '#sameValue',
  ],
  'packages/domain/src/audit/changes.ts#flatten': ['#MAX_DEPTH', '#flatten', '#isNothing', '#isPlainObject'],
  'packages/domain/src/audit/changes.ts#rawText': ['#rawText'],
  'packages/domain/src/audit/changes.ts#renderAuditChanges': [
    '#lastSegment',
    '#renderAuditValue',
    'packages/domain/src/audit/labels.ts#auditFieldLabel',
  ],
  'packages/domain/src/audit/changes.ts#renderAuditValue': ['#MAX_TEXT', '#rawText'],
  'packages/domain/src/audit/changes.ts#sameValue': ['#isNothing'],
  'packages/domain/src/audit/labels.ts#APP_PREFIXES': ['#APPROVAL', '#ENTERPRISE', '#SURVEY360'],
  'packages/domain/src/audit/labels.ts#OBJECTS': [
    '#APPROVAL',
    '#ENTERPRISE',
    '#EVALUATION',
    '#IDP',
    '#ORG_PEOPLE',
    '#QUALIFICATION',
    '#SUCCESSION_META',
    '#SURVEY360',
    '#TALENT',
    '#TALENT_REVIEW_META',
  ],
  'packages/domain/src/audit/labels.ts#SUCCESSION_META': [
    'packages/domain/src/succession/catalog.ts#SUCCESSION_APP_LABEL',
    'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS',
    'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECT_LABELS',
  ],
  'packages/domain/src/audit/labels.ts#TALENT_REVIEW_META': [
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_APP_LABEL',
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS',
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECT_LABELS',
  ],
  'packages/domain/src/audit/labels.ts#auditFieldLabel': ['#FIELD_LABELS'],
  'packages/domain/src/audit/labels.ts#auditObjectMeta': ['#APP_PREFIXES', '#OBJECTS', '#ORG_PEOPLE'],
  'packages/domain/src/audit/retention.ts#addMonths': ['#ISO_DATE'],
  'packages/domain/src/audit/retention.ts#auditQueryWindow': ['#addMonths'],
  'packages/domain/src/audit/retention.ts#isIsoDate': ['#ISO_DATE'],
  'packages/domain/src/audit/retention.ts#resolveAuditRetention': [
    '#DEFAULT_AUDIT_RETENTION',
    '#MAX_AUDIT_RETAIN_MONTHS',
  ],
};
