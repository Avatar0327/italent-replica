/**
 * 直接依赖图汇总：按区域文件拼成一张图（区域由生成器决定，新增区域时一并重写）。
 * 生成文件（F-072）：改源码后用 `ROUTE_POLICY_UPDATE_DIGESTS=1` 重算，不要手改；冲突时取任一侧后重算。
 */
import type { Graph } from '../../../evidence-graph.js';
import { GRAPH as api_audit } from './api-audit.js';
import { GRAPH as api_modules_approval } from './api-modules-approval.js';
import { GRAPH as api_modules_avatar } from './api-modules-avatar.js';
import { GRAPH as api_modules_contracts } from './api-modules-contracts.js';
import { GRAPH as api_modules_employee_self_service } from './api-modules-employee-self-service.js';
import { GRAPH as api_modules_employment } from './api-modules-employment.js';
import { GRAPH as api_modules_establishment } from './api-modules-establishment.js';
import { GRAPH as api_modules_idp } from './api-modules-idp.js';
import { GRAPH as api_modules_job } from './api-modules-job.js';
import { GRAPH as api_modules_org } from './api-modules-org.js';
import { GRAPH as api_modules_permission } from './api-modules-permission.js';
import { GRAPH as api_modules_personnel } from './api-modules-personnel.js';
import { GRAPH as api_modules_qualification } from './api-modules-qualification.js';
import { GRAPH as api_modules_succession } from './api-modules-succession.js';
import { GRAPH as api_modules_survey360 } from './api-modules-survey360.js';
import { GRAPH as api_modules_talent } from './api-modules-talent.js';
import { GRAPH as api_modules_talent_review } from './api-modules-talent-review.js';
import { GRAPH as api_modules_tenant_settings } from './api-modules-tenant-settings.js';
import { GRAPH as api_modules_transfer } from './api-modules-transfer.js';
import { GRAPH as api_root } from './api-root.js';
import { GRAPH as api_route_policy } from './api-route-policy.js';
import { GRAPH as domain_approval } from './domain-approval.js';
import { GRAPH as domain_audit } from './domain-audit.js';
import { GRAPH as domain_contracts } from './domain-contracts.js';
import { GRAPH as domain_employment } from './domain-employment.js';
import { GRAPH as domain_evaluation } from './domain-evaluation.js';
import { GRAPH as domain_expression } from './domain-expression.js';
import { GRAPH as domain_idp } from './domain-idp.js';
import { GRAPH as domain_permission } from './domain-permission.js';
import { GRAPH as domain_personnel } from './domain-personnel.js';
import { GRAPH as domain_platform } from './domain-platform.js';
import { GRAPH as domain_qualification } from './domain-qualification.js';
import { GRAPH as domain_root } from './domain-root.js';
import { GRAPH as domain_succession } from './domain-succession.js';
import { GRAPH as domain_survey360 } from './domain-survey360.js';
import { GRAPH as domain_talent } from './domain-talent.js';
import { GRAPH as domain_talent_review } from './domain-talent-review.js';
import { GRAPH as domain_transfer } from './domain-transfer.js';

export const GRAPH: Graph = {
  ...api_audit,
  ...api_modules_approval,
  ...api_modules_avatar,
  ...api_modules_contracts,
  ...api_modules_employee_self_service,
  ...api_modules_employment,
  ...api_modules_establishment,
  ...api_modules_idp,
  ...api_modules_job,
  ...api_modules_org,
  ...api_modules_permission,
  ...api_modules_personnel,
  ...api_modules_qualification,
  ...api_modules_succession,
  ...api_modules_survey360,
  ...api_modules_talent,
  ...api_modules_talent_review,
  ...api_modules_tenant_settings,
  ...api_modules_transfer,
  ...api_root,
  ...api_route_policy,
  ...domain_approval,
  ...domain_audit,
  ...domain_contracts,
  ...domain_employment,
  ...domain_evaluation,
  ...domain_expression,
  ...domain_idp,
  ...domain_permission,
  ...domain_personnel,
  ...domain_platform,
  ...domain_qualification,
  ...domain_root,
  ...domain_succession,
  ...domain_survey360,
  ...domain_talent,
  ...domain_talent_review,
  ...domain_transfer,
};
