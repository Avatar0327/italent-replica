import { type OperationLogItem, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { type ImportRowAnchor, rawImportRows, rawUuid } from '../../audit/record.js';
import { loadEmploymentBusiness } from './read-model.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';

/** 失败导入最多按这么多行回查现有记录（与导入批次上限一致，异常请求不放大查询）。 */
const MAX_LOOKUP_ROWS = 100;

/**
 * 成功的任职导入逐行保存实际的任职业务编号、员工与记录部门（PR #75 第五轮）：“使用用户”维度按任职业务的创建人
 * 解析，组织维度按 DEC-177（记录部门 ∪ 员工当前部门）判断。
 */
export function importedItems(saved: readonly EmploymentBusiness[]): OperationLogItem[] {
  return saved.map((business, rowIndex) => ({
    rowIndex,
    outcome: 'succeeded' as const,
    objectId: business.id,
    employeeId: business.employeeId,
    orgId: business.fields.departmentId ?? null,
  }));
}

/**
 * 失败的任职导入逐行补归属（PR #75 第五轮）：员工取自请求路径；编辑行的任职业务编号须是该员工现有的记录，才取它
 * 的编号与记录部门；新增行取请求里的部门。识别不出业务对象的行，“使用用户”维度回退为执行人（visibility.ts）。
 */
export async function failedImportAnchors(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  raw: unknown,
): Promise<ImportRowAnchor[]> {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const anchors: ImportRowAnchor[] = [];
  for (const [rowIndex, row] of rawImportRows(raw, 'items').entries()) {
    const business = row.business as { fields?: { departmentId?: unknown } } | undefined;
    const anchor = { employeeId, orgId: rawUuid(business?.fields?.departmentId) };
    const id = rowIndex < MAX_LOOKUP_ROWS ? rawUuid(row.id) : null;
    const existing = id ? await loadEmploymentBusiness(tx, ctx.tenantId, id, asOf) : null;
    anchors.push(
      existing?.employeeId === employeeId
        ? { ...anchor, objectId: existing.id, orgId: existing.fields.departmentId ?? null }
        : anchor,
    );
  }
  return anchors;
}
