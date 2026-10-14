/**
 * 员工自动身份（employee_self_service）的即时派生（F-141 ①，DEC-500）：与经理自助同法，不写授权行。
 * 条件只有两个——当前租户里成员关系有效、且该用户绑定了员工；满足时才把“员工”身份的对象权限叠加进来，
 * 未绑定的成员得不到任何东西，也不改变数据范围（范围仍由用户 × 应用的授权决定，员工自己的“本人”范围只在本人入口里）。
 */
import { sql, type Tx } from '@italent/db';
import { EMPLOYEE_SELF_SERVICE_CODE } from '@italent/domain';
import { scopeRows } from './scope-hierarchy.js';

export async function employeeIdentityProfileId(tx: Tx, tenantId: string, userId: string): Promise<string | null> {
  const [row] = scopeRows<{ id: string }>(
    await tx.execute(sql`
    SELECT p.id FROM permission_user_person_links l
    JOIN tenant_memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id AND m.status='active'
    JOIN permission_profiles p ON p.tenant_id=l.tenant_id AND p.code=${EMPLOYEE_SELF_SERVICE_CODE}
    WHERE l.tenant_id=${tenantId} AND l.user_id=${userId}::uuid LIMIT 1
  `),
  );
  return row?.id ?? null;
}
