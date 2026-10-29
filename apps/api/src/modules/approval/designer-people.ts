/** DEC-686① / DEC-135：设计器取账号 ID，共用组织模块在职投影，不按操作者的人事范围过滤。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { currentAuditRequest } from '../../audit/request-context.js';
import { AppError } from '../../errors.js';
import { activeEmployees } from '../employment/org-people.js';
import { canonicalId, rowsOf } from './context.js';

export interface DesignerPerson {
  userId: string;
  name: string;
  code: string;
  departmentId: string | null;
  departmentName: string | null;
}
const querySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(5000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  userIds: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.uuid().transform(canonicalId)).min(1).max(100))
    .optional(),
});
export function designerPeopleQuery(query: Record<string, string>) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '选人查询参数不合法');
  return parsed.data;
}

/** 保留 assertFallbackUsers(tx, tenantId, node) 的复用签名；HTTP 时钟沿用注入的业务时钟，日期取租户时区。 */
async function currentDate(tx: Tx) {
  const [tenant] = rowsOf<{ timezone: string }>(await tx.execute(sql`SELECT current_tenant_timezone() AS timezone`));
  if (!tenant) throw new AppError('NOT_FOUND', '租户不存在');
  return tenantLocalDate(currentAuditRequest()?.clock() ?? new Date(), tenant.timezone);
}

/** 候选及保存唯一资格入口；绑定档案视为内部员工，但显式变成外部的成员必须排除。 */
export async function eligibleDesignerPeople(
  tx: Tx,
  tenantId: string,
  query: { userIds?: readonly string[]; keyword?: string; limit: number; offset: number },
): Promise<DesignerPerson[]> {
  const asOf = await currentDate(tx);
  const pattern = `%${(query.keyword ?? '').replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const ids = query.userIds ? sql`AND l.user_id = ANY(${`{${query.userIds.join(',')}}`}::uuid[])` : sql``;
  return rowsOf<DesignerPerson>(
    await tx.execute(sql`
    SELECT l.user_id AS "userId", c.name, c.code, c.department_id AS "departmentId", d.name AS "departmentName"
    FROM (${activeEmployees(tenantId, asOf)}) c
    JOIN permission_user_person_links l ON l.tenant_id=${tenantId} AND l.employee_id=c.id
    JOIN tenant_memberships m ON m.tenant_id=l.tenant_id AND m.user_id=l.user_id
      AND m.status='active' AND m.user_type IS DISTINCT FROM 'external'
    JOIN LATERAL tenant_member_accounts(ARRAY[l.user_id]) a ON a.status='active'
    LEFT JOIN LATERAL (
      SELECT v.name FROM org_versions v WHERE v.tenant_id=${tenantId} AND v.org_id=c.department_id
        AND v.start_date<=${asOf}::date ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1
    ) d ON true
    WHERE (c.name ILIKE ${pattern} ESCAPE '\\' OR c.code ILIKE ${pattern} ESCAPE '\\') ${ids}
    ORDER BY c.code,c.id,l.user_id LIMIT ${query.limit} OFFSET ${query.offset}
  `),
  );
}
export async function listDesignerPeople(tx: Tx, tenantId: string, query: ReturnType<typeof designerPeopleQuery>) {
  const size = query.userIds ? query.userIds.length : query.pageSize;
  const items = await eligibleDesignerPeople(tx, tenantId, {
    ...query,
    limit: size + 1,
    offset: query.userIds ? 0 : (query.page - 1) * size,
  });
  return { items: items.slice(0, size), page: query.page, pageSize: size, hasMore: items.length > size };
}
