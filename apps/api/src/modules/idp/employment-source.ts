/**
 * 带出值的源任职记录可见判定（DEC-309 E3 / E10）：与任职记录接口同一谓词（DEC-177），含记录创建人——“使用用户”
 * 维度下操作人创建的记录可见（DEC-198；PR #115 第 3 轮 R2-7）。指导人解析（含间接经理逐跳）与任职生效日推算共用。
 */
import { sql, type Tx } from '@italent/db';
import { employmentCreator } from '../employment/context.js';
import type { findCurrentRecord } from '../employment/read-model.js';
import { isEmploymentRecordVisible } from '../employment/visibility.js';
import { type ModuleScope, rowsOf } from './access.js';

type EmploymentRecord = NonNullable<Awaited<ReturnType<typeof findCurrentRecord>>>;

export async function sourceRecordVisible(
  tx: Tx,
  tenantId: string,
  scope: ModuleScope,
  record: EmploymentRecord,
): Promise<boolean> {
  const departmentId = (record.fields.departmentId as string | null | undefined) ?? null;
  const [row] = rowsOf<{ creator: string | null }>(
    await tx.execute(sql`SELECT ${employmentCreator(tenantId, sql`${record.id}::uuid`, true)} AS creator`),
  );
  return isEmploymentRecordVisible(tx, tenantId, scope, {
    employeeId: record.employeeId,
    departmentId,
    creatorId: row?.creator ?? null,
  });
}
