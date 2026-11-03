/** 报表已按取数日裁剪的员工集合；历史 / 未来部门不能授予候选资格（F-418 P1-1）。 */
import { sql } from '@italent/db';
import type { SQL } from 'drizzle-orm';

export function projectionEmployeeScope(visibleEmployeeIds: readonly string[], employee: SQL): SQL {
  return sql`${employee} = ANY(${`{${visibleEmployeeIds.join(',')}}`}::uuid[])`;
}
