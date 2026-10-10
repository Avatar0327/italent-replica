/**
 * 直接依赖图：区域 domain-permission（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'packages/domain/src/permission/admin-roles.ts#isAdminRole': ['#ADMIN_ROLES'],
  'packages/domain/src/permission/module-actions.ts#MODULE_OBJECTS': [
    'packages/domain/src/approval/transfer-view.ts#TRANSFER_LINKAGE_FIELDS',
    'packages/domain/src/contracts/rules.ts#CONTRACT_FIELDS',
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
