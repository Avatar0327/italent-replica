/** DEC-233：已处理列表与节点编辑元数据按当前范围裁剪；审批参与本身不授予业务数据范围。 */
import { sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCreator } from '../employment/context.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import { resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { instanceScopeSql } from './access.js';

/** SQL 谓词作用于 approval_instances 别名 i，放在 LIMIT/OFFSET 前，空范围拒绝。 */
export async function currentReadScope(tx: Tx, deps: TenantRouteDeps, ctx: TenantContext) {
  const object = MODULE_OBJECTS.employmentRecord.code;
  const employment = await resolveModuleScopeInTransaction(deps, ctx, tx, object, `${object}.list`);
  const contract = await resolveModuleScopeInTransaction(deps, ctx, tx, CONTRACT_OBJECT, `${CONTRACT_OBJECT}.list`);
  const businessDepartment = sql`(SELECT p.department_id FROM employment_payload_versions p
    WHERE p.tenant_id=i.tenant_id AND p.business_id=i.business_id ORDER BY p.version_no DESC LIMIT 1)`;
  // DEC-177：记录部门或员工当前部门在范围内即可查看；统一复用任职 visibility，不另造历史范围语义。
  const visibleEmployment = employmentVisibilitySql(employment, {
    employee: sql`i.subject_employee_id`,
    department: businessDepartment,
    creator: employmentCreator(ctx.tenantId, sql`i.business_id`, true),
  });
  return sql`((i.business_type='employment' AND ${visibleEmployment})
    OR (i.business_type='contract' AND ${instanceScopeSql(ctx, contract)})
    OR (i.business_type='personnel_change' AND ${instanceScopeSql(ctx, employment)}))`;
}
