/**
 * 应用级登记表（F-039 PR-A）：根路由器的 `/healthz`，以及直接挂在租户路由器上的模块登记表的合并。
 * 子应用（employment / approval / contracts / self-service / survey360 两个）在各自路由文件里经 policedSub 套自己的表；
 * 平台路由器在 modules/platform/routes.ts 套 PLATFORM_POLICIES。新模块：写好 policy.ts 后在这里追加一行。
 */
import { AUDIT_POLICIES } from './audit/policy.js';
import { AVATAR_POLICIES } from './modules/avatar/policy.js';
import { ESTABLISHMENT_POLICIES } from './modules/establishment/policy.js';
import { IDP_POLICIES } from './modules/idp/policy.js';
import { JOB_POLICIES } from './modules/job/policy.js';
import { ORG_POLICIES } from './modules/org/policy.js';
import { PERMISSION_POLICIES } from './modules/permission/policy.js';
import { PERSONNEL_POLICIES } from './modules/personnel/policy.js';
import { QUALIFICATION_POLICIES } from './modules/qualification/policy.js';
import { TALENT_POLICIES } from './modules/talent/policy.js';
import { TALENT_REVIEW_POLICIES } from './modules/talent-review/policy.js';
import { TENANT_SETTING_POLICIES } from './modules/tenant-settings/policy.js';
import { defineTable, mergeTables, type PolicyTable } from './route-policy/index.js';
import { publicRoute } from './route-policy/presets.js';

export const ROOT_POLICIES = defineTable('root', {
  // 健康检查无数据、无租户；公开路由必须带 guards，这里为空并写明原因（DEC-291 Q2）
  'GET /healthz': publicRoute('健康检查只返回 { status }，不读任何租户数据，故 guards 为空', 'DEC-291 Q2', []),
});

/** 直接挂在租户路由器上的模块登记表（含测试夹具追加的表）；键重叠在合并时报错。 */
export function tenantPolicyTable(extra: readonly PolicyTable[] = []): PolicyTable {
  return mergeTables('tenant', [
    TENANT_SETTING_POLICIES,
    PERMISSION_POLICIES,
    ORG_POLICIES,
    JOB_POLICIES,
    ESTABLISHMENT_POLICIES,
    PERSONNEL_POLICIES,
    AUDIT_POLICIES,
    TALENT_POLICIES,
    IDP_POLICIES,
    AVATAR_POLICIES,
    TALENT_REVIEW_POLICIES,
    QUALIFICATION_POLICIES,
    ...extra,
  ]);
}
