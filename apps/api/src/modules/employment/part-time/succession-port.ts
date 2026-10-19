/**
 * 继任风险计算的兼职现任端口（docs/08_设计/R2-T05_兼职设计.md §6，PB-52；R3-T05 设计 §6.3）：asOf 当日进行中、
 * 当前职位 = 该职位的兼职员工。是否参与计算由租户设置 succession.part_time_in_risk_calc 决定（本租户默认关），
 * 开关关时 risk-people.ts 不调用本端口。可信端口：在调用方的租户事务内执行，不做查看人范围裁剪（同 loadIncumbentIds）。
 * 在 succession/ports.ts 的 SUCCESSION_PORTS 常量里直接引用（随 installSuccessionPorts 生效，常量无重复登记问题）。
 */
import { sql } from '@italent/db';
import { rowsOf } from '../record-store.js';
import type { SuccessionReadContext } from '../../succession/ports.js';
import { PART_TIME_END, PART_TIME_POSITION, PART_TIME_START, partTimeFrom } from './read.js';
import { partTimeCurrentSql } from './span-sql.js';

export async function riskPartTimeIncumbents(ctx: SuccessionReadContext, positionId: string): Promise<string[]> {
  const rows = rowsOf<{ employeeId: string }>(
    await ctx.tx.execute(sql`
      SELECT r.employee_id AS "employeeId" ${partTimeFrom(ctx)}
      WHERE r.tenant_id=${ctx.tenantId} AND r.service_type <> 'primary' AND r.kind='part_time'
        AND ${PART_TIME_POSITION} = ${positionId}::uuid
        AND ${partTimeCurrentSql(PART_TIME_START, PART_TIME_END, ctx.asOf)}
      GROUP BY r.employee_id ORDER BY min(r.start_date), r.employee_id
    `),
  );
  return rows.map((row) => row.employeeId);
}
