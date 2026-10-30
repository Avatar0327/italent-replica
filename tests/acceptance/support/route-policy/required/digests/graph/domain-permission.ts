/**
 * 直接依赖图：区域 domain-permission（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/permission/admin-roles.ts#hasAdminCapability': ['#CAPABILITY_HOLDERS'],
  'packages/domain/src/permission/admin-roles.ts#isAdminCapability': ['#CAPABILITY_HOLDERS'],
  'packages/domain/src/permission/admin-roles.ts#isAdminRole': ['#ADMIN_ROLES'],
  'packages/domain/src/permission/decide.ts#BUTTON_RESOURCE': [
    'packages/domain/src/permission/object-permission.ts#BUTTON_LEVELS',
  ],
  'packages/domain/src/permission/decide.ts#allows': [
    'packages/domain/src/permission/effective.ts#fieldWriteViolations',
  ],
  'packages/domain/src/permission/decide.ts#decide': [
    '#OBJECT_ACTIONS',
    '#allows',
    '#decideAdmin',
    '#decideButton',
    'packages/domain/src/permission/effective.ts#resolveObjectPermission',
    'packages/domain/src/permission/module-actions.ts#MODULE_ACTIONS',
  ],
  'packages/domain/src/permission/decide.ts#decideAdmin': [
    'packages/domain/src/permission/admin-roles.ts#hasAdminCapability',
    'packages/domain/src/permission/admin-roles.ts#isAdminCapability',
  ],
  'packages/domain/src/permission/decide.ts#decideButton': [
    '#BUTTON_RESOURCE',
    'packages/domain/src/permission/effective.ts#executableButtons',
    'packages/domain/src/permission/effective.ts#resolveObjectPermission',
  ],
  'packages/domain/src/permission/effective.ts#executableButtons': [
    'packages/domain/src/permission/object-permission.ts#buttonKey',
  ],
  'packages/domain/src/permission/effective.ts#mergeObjectPermissions': [
    '#NONE',
    'packages/domain/src/permission/object-permission.ts#buttonKey',
  ],
  'packages/domain/src/permission/effective.ts#resolveObjectPermission': [
    '#mergeObjectPermissions',
    'packages/domain/src/permission/object-permission.ts#isWithinProfileApps',
  ],
  'packages/domain/src/permission/module-actions.ts#MODULE_ACTIONS': ['#actions'],
  'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS': [
    'packages/domain/src/approval/transfer-view.ts#TRANSFER_LINKAGE_FIELDS',
    'packages/domain/src/contracts/rules.ts#CONTRACT_FIELDS',
    'packages/domain/src/employment/assessment.ts#ASSESSMENT_BUTTONS',
    'packages/domain/src/employment/assessment.ts#ASSESSMENT_FIELDS',
    'packages/domain/src/employment/assessment.ts#ASSESSMENT_SYSTEM_FIELDS',
    'packages/domain/src/employment/exit.ts#EXIT_BUTTONS',
    'packages/domain/src/employment/exit.ts#EXIT_REQUEST_FIELDS',
    'packages/domain/src/employment/exit.ts#EXIT_REQUEST_SYSTEM_FIELDS',
    'packages/domain/src/employment/exit.ts#RETIREMENT_BUTTONS',
    'packages/domain/src/employment/part-time-constants.ts#PART_TIME_BUTTONS',
    'packages/domain/src/employment/part-time-constants.ts#PART_TIME_FIELDS',
    'packages/domain/src/employment/part-time-constants.ts#PART_TIME_SYSTEM_FIELDS',
    'packages/domain/src/employment/retirement-intention.ts#RETIREMENT_INTENTION_BUTTON',
    'packages/domain/src/employment/retirement-intention.ts#RETIREMENT_INTENTION_EDITABLE_FIELDS',
    'packages/domain/src/employment/retirement-intention.ts#RETIREMENT_INTENTION_SNAPSHOT_FIELDS',
    'packages/domain/src/employment/retirement.ts#RETIREMENT_REQUEST_FIELDS',
    'packages/domain/src/offer/approval.ts#OFFER_APPROVAL_PROGRESS_FIELDS',
    'packages/domain/src/offer/approval.ts#OFFER_BATCH_FIELDS',
    'packages/domain/src/offer/rules.ts#OFFER_BUTTONS',
    'packages/domain/src/offer/rules.ts#OFFER_FIELDS',
    'packages/domain/src/offer/rules.ts#OFFER_STATUS_FIELDS',
    'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_DETAIL_OBJECT_CODE',
    'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_FORM_FIELDS',
    'packages/domain/src/org-adjustment/fields.ts#ORG_ADJUSTMENT_OBJECT_CODE',
    '#assignment',
    '#button',
    '#crud',
    '#job',
    '#object',
  ],
  'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS>establishment': ['#button', '#crud', '#object'],
  'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS>organization': ['#button', '#crud', '#object'],
  'packages/domain/src/permission/module-actions.ts#actions': ['#tenantConfiguration'],
  'packages/domain/src/permission/module-actions.ts#assignment': ['#ranges'],
  'packages/domain/src/permission/module-actions.ts#crud': ['#button'],
  'packages/domain/src/permission/module-actions.ts#job': ['#button', '#jobButtons', '#jobCommon', '#object'],
  'packages/domain/src/permission/module-actions.ts#jobButtons': ['#button', '#crud'],
  'packages/domain/src/permission/module-actions.ts#object': ['#ORG_EMPLOYEE_APP', '#crud', '#systemFields'],
  'packages/domain/src/permission/object-permission.ts#buttonViolations': ['#buttonKey'],
  'packages/domain/src/permission/object-permission.ts#validateObjectPermission': [
    '#buttonViolations',
    '#fieldViolations',
  ],
};
