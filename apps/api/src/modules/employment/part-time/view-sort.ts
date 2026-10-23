import { sql } from '@italent/db';
import { PART_TIME_SERVICE_TYPES, type PartTimeView } from '@italent/domain';
import type { SQL } from 'drizzle-orm';

export const SORT_FIELDS = [
  'code',
  'serviceType',
  'effectiveDate',
  'endDate',
  'departmentId',
  'institutionId',
  'directManagerId',
  'postId',
] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export interface ViewSort {
  readonly sortBy?: SortField;
  readonly direction?: 'asc' | 'desc';
}

/** F234B B5：审批中的工号无排序；经理仅未开始 / 审批中，职务仅审批中。机构按 F255A 六视图均可排序。 */
export function sortable(view: PartTimeView, field: SortField): boolean {
  if (field === 'code') return view !== 'in_approval';
  if (field === 'directManagerId') return view === 'not_started' || view === 'in_approval';
  if (field === 'postId') return view === 'in_approval';
  return true;
}

export interface ViewColumns {
  readonly department: SQL;
  readonly institution: SQL;
  readonly serviceType: SQL;
  readonly start: SQL;
  readonly end: SQL;
  readonly directManager: SQL;
  readonly post: SQL;
}

/** DEC-673：未取证细节沿用列表约定；组织 / 职务用 DEC-089 名次，引用人员用工号，空值最后。 */
export function viewOrder(
  tenantId: string,
  today: string,
  input: ViewSort & { readonly view: PartTimeView },
  columns: ViewColumns,
): SQL {
  const approval = input.view === 'in_approval';
  const id = approval ? sql`q.id` : sql`r.id`;
  if (!input.sortBy) {
    if (input.view === 'expiring') return sql`${columns.start} ASC, ${id} ASC`;
    return approval ? sql`${columns.start} DESC, q.created_at DESC, ${id}` : sql`${columns.start} DESC, ${id}`;
  }
  const ranks = {
    institutionId: sql`(SELECT rank.sort_number FROM personnel_org_sort_ranks rank
      WHERE rank.tenant_id=${tenantId} AND rank.org_id=${columns.institution}
        AND rank.valid_from<=${today}::date AND rank.valid_to>${today}::date)`,
    departmentId: sql`(SELECT rank.sort_number FROM personnel_org_sort_ranks rank
      WHERE rank.tenant_id=${tenantId} AND rank.org_id=${columns.department}
        AND rank.valid_from<=${today}::date AND rank.valid_to>${today}::date)`,
    postId: sql`(SELECT rank.sort_number FROM personnel_post_sort_ranks rank
      WHERE rank.tenant_id=${tenantId} AND rank.post_id=${columns.post}
        AND rank.valid_from<=${today}::date AND rank.valid_to>${today}::date)`,
  };
  const types = PART_TIME_SERVICE_TYPES.map((type) => sql`${type}`);
  const values: Record<SortField, SQL> = {
    code: sql`e.code`,
    effectiveDate: columns.start,
    endDate: columns.end,
    serviceType: sql`array_position(ARRAY[${sql.join(types, sql`, `)}]::text[], ${columns.serviceType})`,
    ...ranks,
    directManagerId: sql`(SELECT manager.code FROM employment_employees manager
      WHERE manager.tenant_id=${tenantId} AND manager.id=${columns.directManager})`,
  };
  const direction = input.direction === 'desc' ? sql`DESC` : sql`ASC`;
  return sql`${values[input.sortBy]} ${direction} NULLS LAST, ${id} ASC`;
}
