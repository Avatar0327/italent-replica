/**
 * 直接依赖图：区域 domain-platform（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/platform/sha256.ts#sha256Hex': ['#K', '#rotr', '#utf8'],
  'packages/domain/src/platform/standard-grants.ts#objectCatalogDigest': [
    'packages/domain/src/platform/sha256.ts#sha256Hex',
  ],
  'packages/domain/src/platform/standard-grants.ts#objectGrantItems': [
    '#buttonGrantCode',
    '#fieldGrantCode',
    '#objectGrantCode',
    '#opGrantCode',
  ],
  'packages/domain/src/platform/standard-presets.ts#BUSINESS_OBJECTS': [
    'packages/domain/src/approval/catalog.ts#APPROVAL_OBJECTS',
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
    'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECTS',
    '#CONFIG_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#CONFIG_OBJECTS': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#EMPLOYEE_PROFILE': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
    'packages/domain/src/permission/module-actions.ts#ORG_EMPLOYEE_APP',
    'packages/domain/src/platform/employee-self-service.ts#EMPLOYEE_DEFAULT_CREATE',
    'packages/domain/src/platform/employee-self-service.ts#EMPLOYEE_DEFAULT_EDIT_FIELDS',
    'packages/domain/src/platform/employee-self-service.ts#EMPLOYEE_PAGES',
    'packages/domain/src/platform/employee-self-service.ts#EMPLOYEE_READONLY_FIELDS',
    'packages/domain/src/platform/employee-self-service.ts#EMPLOYEE_SELF_SERVICE_BUTTONS',
    'packages/domain/src/platform/employee-self-service.ts#EMPLOYEE_SELF_SERVICE_CODE',
    '#fieldSubset',
    'packages/domain/src/qualification/catalog.ts#QUALIFICATION_APP',
    'packages/domain/src/qualification/catalog.ts#QUALIFICATION_PAGES',
  ],
  'packages/domain/src/platform/standard-presets.ts#ESTABLISHMENT_SCHEME_DATASOURCE': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#MANAGER_OBJECTS': [
    'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS',
    'packages/domain/src/personnel/catalog.ts#PERSONNEL_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#QUALIFICATION_PROFILES': [
    'packages/domain/src/evaluation/catalog.ts#EVALUATION_APP',
    'packages/domain/src/evaluation/catalog.ts#EVALUATION_OBJECTS',
    'packages/domain/src/evaluation/flow-catalog.ts#EVALUATION_FLOW_OBJECTS',
    '#full',
    '#readOnly',
    'packages/domain/src/qualification/catalog.ts#QUALIFICATION_APP',
    'packages/domain/src/qualification/catalog.ts#QUALIFICATION_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#STANDARD_PROFILES': [
    'packages/domain/src/approval/catalog.ts#APPROVAL_PROCESS_OBJECT',
    'packages/domain/src/permission/module-actions.ts#ORG_EMPLOYEE_APP',
    '#BUSINESS_OBJECTS',
    '#CORE_HR',
    '#EMPLOYEE_PROFILE',
    '#MANAGER_OBJECTS',
    '#QUALIFICATION_PROFILES',
    '#SUCCESSION_PROFILES',
    '#full',
    '#readOnly',
    'packages/domain/src/survey360/catalog.ts#SURVEY360_APP',
    'packages/domain/src/survey360/catalog.ts#SURVEY360_PROFILES',
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_APP',
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_CONFIG_OBJECTS',
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_OBJECTS',
    'packages/domain/src/talent-review/catalog.ts#TALENT_REVIEW_SEE_ALL_UNAPPROVED',
    'packages/domain/src/talent/catalog.ts#TALENT_APP',
    'packages/domain/src/talent/catalog.ts#TALENT_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#SUCCESSION_PROFILES': [
    '#ALL_WRITES',
    '#full',
    '#partial',
    '#succession',
    'packages/domain/src/succession/catalog.ts#SUCCESSION_APP',
    'packages/domain/src/succession/catalog.ts#SUCCESSION_CONFIG_OBJECTS',
    'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS',
  ],
  'packages/domain/src/platform/standard-presets.ts#partial': ['#full'],
  'packages/domain/src/platform/standard-presets.ts#succession': [
    'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS',
  ],
};
