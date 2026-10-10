/**
 * 直接依赖图：区域 api-modules-succession（节点 → 直接依赖，字典序；同文件的依赖写作 #名字；没有依赖的叶子不登记）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';

export const GRAPH: Graph = {
  'apps/api/src/modules/succession/access.ts#codeOf': ['packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS'],
  'apps/api/src/modules/succession/access.ts#requireFilterVisible': [
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    '#codeOf',
  ],
  'apps/api/src/modules/succession/access.ts#successionContext': [
    'apps/api/src/modules/permission/module-route-access.ts#objectContext',
    '#codeOf',
  ],
  'apps/api/src/modules/succession/access.ts#successionScope': [
    'apps/api/src/modules/permission/module-route-access.ts#requestScope',
    '#codeOf',
  ],
  'apps/api/src/modules/succession/audit-scope.ts#SUCCESSION_AUDIT': ['#recordSelfRestrict'],
  'apps/api/src/modules/succession/audit-scope.ts#recordSelfRestrict': [
    'apps/api/src/modules/succession/read-sql.ts#selfRecordHiddenSql',
  ],
  'apps/api/src/modules/succession/ports.ts#installSuccessionPorts': [
    '#SUCCESSION_PORTS',
    'apps/api/src/modules/talent-review/health-port.ts#registerOrgHealthComputePort',
  ],
  'apps/api/src/modules/succession/projection.ts#OBJECT_OF': [
    'packages/domain/src/succession/catalog.ts#SUCCESSION_OBJECTS',
  ],
  'apps/api/src/modules/succession/projection.ts#buildRecordViews': [
    'apps/api/src/modules/succession/read-sql.ts#loadIncumbentIds',
    'apps/api/src/modules/succession/read-sql.ts#loadPeople',
    'apps/api/src/modules/succession/read-sql.ts#loadPersonInChargeIds',
    'apps/api/src/modules/succession/record-read.ts#isOpenEnded',
  ],
  'apps/api/src/modules/succession/projection.ts#projectSuccession': [
    'apps/api/src/modules/permission/module-access.ts#getModuleViewableFields',
    '#GOVERNING_FIELD',
    '#OBJECT_OF',
  ],
  'apps/api/src/modules/succession/read-sql.ts#loadIncumbentIds': [
    '#INCUMBENT_EXCLUDED_STATUSES',
    '#rowsOf',
    '#uuidArray',
  ],
  'apps/api/src/modules/succession/read-sql.ts#loadPeople': ['#personLabel', '#rowsOf', '#uuidArray'],
  'apps/api/src/modules/succession/read-sql.ts#loadPersonInChargeIds': ['#rowsOf', '#uuidArray'],
  'apps/api/src/modules/succession/read-sql.ts#selfRecordHiddenSql': ['#selfSuccessorsHiddenSql', '#selfTargetSql'],
  'apps/api/src/modules/succession/read-sql.ts#selfSuccessorsHiddenSql': ['#SELF_VISIBLE_KEY'],
  'apps/api/src/modules/succession/record-read.ts#conditions': [
    'apps/api/src/modules/permission/module-access.ts#scopeSql',
    'apps/api/src/modules/succession/read-sql.ts#selfRecordHiddenSql',
    '#statusPredicate',
  ],
  'apps/api/src/modules/succession/record-read.ts#listRecordRows': [
    'apps/api/src/modules/succession/read-sql.ts#rowsOf',
    '#conditions',
    '#from',
    '#selectColumns',
    '#toRow',
  ],
  'apps/api/src/modules/succession/record-read.ts#loadRecordRow': [
    'apps/api/src/modules/succession/read-sql.ts#rowsOf',
    '#conditions',
    '#from',
    '#selectColumns',
    '#toRow',
  ],
  'apps/api/src/modules/succession/record-read.ts#toRow': ['#toIso'],
  'apps/api/src/modules/succession/routes.ts#RECORDS': ['apps/api/src/modules/succession/access.ts#SUCCESSION_BASE'],
  'apps/api/src/modules/succession/routes.ts#recordFilter': [
    'apps/api/src/modules/succession/access.ts#requireFilterVisible',
    'apps/api/src/modules/succession/record-read.ts#RECORD_STATUS_FILTERS',
    '#optional',
    'apps/api/src/modules/talent/http.ts#uuidQuery',
  ],
  'apps/api/src/modules/succession/routes.ts#recordVisibility': [
    'apps/api/src/modules/org/read-model.ts#validIsoDate',
    'apps/api/src/modules/succession/access.ts#successionScope',
    'packages/domain/src/tenant-time.ts#tenantLocalDate',
  ],
  'apps/api/src/modules/succession/routes.ts#registerSuccessionRoutes': [
    'apps/api/src/modules/succession/access.ts#SUCCESSION_BASE',
    'apps/api/src/modules/succession/access.ts#successionContext',
    'apps/api/src/modules/succession/ports.ts#installSuccessionPorts',
    'apps/api/src/modules/succession/projection.ts#buildRecordViews',
    'apps/api/src/modules/succession/projection.ts#projectSuccession',
    'apps/api/src/modules/succession/record-read.ts#listRecordRows',
    'apps/api/src/modules/succession/record-read.ts#loadRecordRow',
    '#RECORDS',
    '#recordFilter',
    '#recordVisibility',
    'apps/api/src/modules/talent-review/readiness-port.ts#readinessPort',
    'apps/api/src/modules/talent/http.ts#pageQuery',
    'apps/api/src/modules/talent/http.ts#uuidParam',
  ],
};
