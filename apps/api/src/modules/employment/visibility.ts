/**
 * 任职记录对操作人可见的单一判定（DEC-177，`11` §20 / Q-M0-67）。
 *
 * 一条任职记录（含历史、未来、审批中的业务）对操作人可见 ⇔
 *   ① 记录所在部门在其数据范围内，或
 *   ② 该员工**当前**任职部门在其数据范围内（“当前”取授权日，即租户时区的今天，不随查询 asOf 回溯）。
 * 当前在范围内的员工整条任职链可见；已调出的员工只剩部门在范围内的那几段。
 * 汇报关系维度按员工本身判断，使用用户维度按记录创建者判断，与 ①② 取并集（各维度之间本就是 OR）。
 *
 * 调用方式：
 * - 列表 / 导出（SQL 分页前过滤）：`employmentVisibilitySql(scope, { employee, department, creator })`；
 * - 单条判断（详情、联动目标）：`isEmploymentRecordVisible(tx, tenantId, scope, target)`；
 * - 批量判断（嵌套响应、导出回执）：`visibleEmploymentRecords(tx, tenantId, scope, targets)`。
 * scope 为 undefined（可信系统端口）或“看全部”时范围不设限，但单条 / 批量判断仍要求员工属于 tenantId；
 * 范围为空时一律不可见（fail-closed）。
 *
 * 只管“看”（DEC-193）：直接编辑 / 删除 / 撤回 / 重试与写入新部门值仍按 `context.ts` requireScopedEmploymentObject
 * 的写入口径，不随可见放宽；联动改写后续记录按 DEC-178 用本判定（forward-update.ts）。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { scopeSql, type ModuleScope } from '../permission/module-access.js';

export interface EmploymentVisibilityColumns {
  /** 员工 ID 列（uuid）。 */
  readonly employee: SQL;
  /** 该条记录 / 业务所在部门列（uuid，可为 NULL）。 */
  readonly department: SQL;
  /** 记录创建者列；只在范围含“使用用户”维度时参与判断。 */
  readonly creator?: SQL;
}

export interface EmploymentVisibilityTarget {
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly creatorId?: string | null;
}

/** DEC-177 的 SQL 谓词；须放在 LIMIT / OFFSET 之前，不做全租户结果后过滤。 */
export function employmentVisibilitySql(scope: ModuleScope | undefined, columns: EmploymentVisibilityColumns): SQL {
  if (!scope || scope.all) return sql`true`;
  const creator = columns.creator ? { creator: columns.creator } : {};
  // 每个范围维度单独求值后取并集：组织类维度对记录部门（①）与员工当前部门（②，personQuery）各判一次。
  const byRecordDepartment = scopeSql(scope, { org: columns.department, ...creator });
  const byCurrentEmployment = scopeSql(scope, { person: columns.employee, ...creator });
  return sql`(${byRecordDepartment} OR ${byCurrentEmployment})`;
}

/** 单条判断；员工必须属于本租户（不依赖调用方已按租户取数）。 */
export async function isEmploymentRecordVisible(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope | undefined,
  target: EmploymentVisibilityTarget,
): Promise<boolean> {
  const [visible] = await visibleEmploymentRecords(tx, tenantId, scope, [target]);
  return visible === true;
}

/** 批量判断，一次查询；返回与 targets 等长、顺序一致的布尔数组。 */
export async function visibleEmploymentRecords(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope | undefined,
  targets: readonly EmploymentVisibilityTarget[],
): Promise<boolean[]> {
  if (!targets.length) return [];
  // 看全部 / 可信端口也不提前返回：范围谓词为 true，员工归属本租户的 JOIN 照常生效（PR #76 P2-1）。
  const input = targets.map((target, index) => ({
    ord: index,
    employee: target.employeeId,
    department: target.departmentId,
    creator: target.creatorId ?? null,
  }));
  const result = await tx.execute(sql`
    SELECT t.ord FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
      AS t(ord int, employee uuid, department uuid, creator uuid)
    JOIN employment_employees e ON e.tenant_id=${tenantId} AND e.id=t.employee
    WHERE ${employmentVisibilitySql(scope, {
      employee: sql`t.employee`,
      department: sql`t.department`,
      creator: sql`t.creator`,
    })}
  `);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { ord: number }[];
  const visible = new Set(rows.map((row) => Number(row.ord)));
  return targets.map((_, index) => visible.has(index));
}
