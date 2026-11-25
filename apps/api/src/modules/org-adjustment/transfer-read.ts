/**
 * 调动明细分区的读取（R2-T08 §4.5 / §10 路由 13 / 14，BE-11c-b）：行可见性、列裁剪与投影。
 * - HR 路径：来源员工须在任职对象范围（员工 + 基线任职部门，与写路径 `requireScopedEmploymentObject` 同口径，范围为空 =
 *   全部隐去），目标部门须在组织对象范围，引用本单新增组织时该组织行也须可见；任一不满足整行隐去，只计 hiddenRowCount。
 * - 审批人路径（含冻结份）：范围为 null，全部行可见；列只留节点披露 ∩ 查看权里的 `transferItems.*`。
 * - 合同变更：容器 `transferItems.contractChange` 展开为逐行编码（`contractChangeFieldCode`），按各自编码裁剪，
 *   与行序无关；联动其余列（职责转交 / 试岗 / 调薪）按各自编码。
 * 冻结份是 P1 形状（无调动分区）时按“没有调动明细”读，不报错（旧形状容忍）。
 */
import { sql, type Tx } from '@italent/db';
import { CONTRACT_OBJECT, ORG_ADJUSTMENT_CONTRACT_CONTAINER, ORG_ADJUSTMENT_ITEM_RESULT_LABELS } from '@italent/domain';
import { rowsOf } from '../org/read-model.js';
import { scopeSql } from '../permission/module-access.js';
import type { OrgContent } from './content.js';
import { canSee, orgInScope, type Disclosure } from './disclosure.js';
import { contractOwners, type TransferItem } from './transfer-items-store.js';
import { contractEntries } from './transfer-snapshot.js';

export const TRANSFER_SECTION = 'transfer';

/** 调动分区是否对查看人披露：至少一个 `transferItems.*` 字段可见（逐行合同编码也算）。 */
export function transferSectionDisclosed(disclosure: Pick<Disclosure, 'fields'>): boolean {
  const { fields } = disclosure;
  return fields === undefined || [...fields].some((field) => field.startsWith('transferItems.'));
}

export const transfersOf = (source: Pick<OrgContent, 'transfers'>): readonly TransferItem[] => source.transfers ?? [];

/** 本人任职对象范围内的员工行（一次查询，不逐人调用）。 */
type RowScope = Pick<Disclosure, 'orgScope' | 'orgCreators' | 'employmentScope'>;

async function employmentAllowed(tx: Tx, tenantId: string, disclosure: RowScope, rows: readonly TransferItem[]) {
  const scope = disclosure.employmentScope;
  if (!scope) return new Set(rows.map((row) => row.id));
  if (!rows.length) return new Set<string>();
  const allowed = scopeSql(scope, { person: sql`t.employee_id`, org: sql`r.department_id` });
  const found = rowsOf<{ id: string; allowed: boolean }>(
    await tx.execute(sql`SELECT t.id, ${allowed} AS allowed
      FROM org_adjustment_transfer_items t
      JOIN employment_records r
        ON r.tenant_id = t.tenant_id AND r.employee_id = t.employee_id AND r.id = t.base_record_id
      WHERE t.tenant_id = ${tenantId} AND t.id = ANY(${`{${rows.map((row) => row.id).join(',')}}`}::uuid[])`),
  );
  return new Set(found.filter((row) => row.allowed).map((row) => row.id));
}

export async function visibleTransfers(
  tx: Tx,
  tenantId: string,
  disclosure: RowScope,
  source: Pick<OrgContent, 'transfers'>,
  visibleOrgItemIds: ReadonlySet<string>,
) {
  const all = transfersOf(source);
  if (!disclosure.orgScope && !disclosure.employmentScope) return { rows: [...all], hiddenRowCount: 0 };
  const allowed = await employmentAllowed(tx, tenantId, disclosure, all);
  const rows = all.filter(
    (row) =>
      allowed.has(row.id) &&
      (!row.departmentId || orgInScope(disclosure, row.departmentId)) &&
      (!row.departmentItemId || visibleOrgItemIds.has(row.departmentItemId)),
  );
  return { rows, hiddenRowCount: all.length - rows.length };
}

export interface TransferContext {
  /** 本查看人可见的合同变更逐行编码（容器可见 ∧ 合同对象判定通过）。 */
  readonly contractCodes: ReadonlySet<string>;
  readonly fields: ReadonlySet<string> | undefined;
  readonly names: ReadonlyMap<string, string>;
  readonly sources: ReadonlyMap<string, string | null>;
  readonly results: ReadonlyMap<string, { result: 1 | 2 | null; reason: string | null; message: string | null }>;
}

/** 行身份与基线列总是返回；内容列按 `transferItems.<字段>`；合同变更逐行编码各自裁剪。 */
export function projectTransfer(row: TransferItem, context: TransferContext) {
  const { fields, names } = context;
  const see = (field: string) => canSee(fields, `transferItems.${field}`);
  const orgName = (orgId: string | null) => (orgId ? (names.get(orgId) ?? null) : null);
  const out: Record<string, unknown> = {
    id: row.id,
    seq: row.seq,
    generatedByItemId: row.generatedByItemId,
    generatedReason: row.generatedReason,
    baseRecordId: row.baseRecordId,
    baseEmployeeRevision: row.baseEmployeeRevision,
  };
  if (see('employeeId')) out.employeeId = row.employeeId;
  if (see('departmentId')) {
    const original = context.sources.get(row.id) ?? null;
    Object.assign(out, {
      departmentId: row.departmentId,
      departmentItemId: row.departmentItemId,
      departmentName: orgName(row.departmentId),
      originalDepartmentId: original,
      originalDepartmentName: orgName(original),
    });
  }
  for (const key of ['positionId', 'postId', 'levelId', 'directManagerId', 'withEstablishment'] as const) {
    if (see(key)) out[key] = row[key];
  }
  if (see('directManagerId')) Object.assign(out, { dottedManagerId: row.dottedManagerId });
  const linkage = row.linkage;
  if (see('dutyTransfer')) out.dutyTransfer = linkage?.dutyTransfer ?? null;
  if (see('trial')) out.trial = linkage?.onTrial ?? null;
  if (see('adjustSalary')) out.adjustSalary = linkage?.adjustSalary ?? false;
  out.contractChange = visibleContract(row, context.contractCodes);
  const result = context.results.get(row.id);
  const code = result?.result ?? null;
  return Object.assign(out, {
    executionResult: code,
    executionResultLabel: code ? ORG_ADJUSTMENT_ITEM_RESULT_LABELS[code] : null,
    executionReason: result?.reason ?? null,
    executionMessage: result?.message ?? null,
  });
}

/** 合同变更：只列查看人可见的逐行编码对应的字段；一个都不可见时为 null（不暴露“是否变更合同”）。 */
function visibleContract(row: TransferItem, codes: ReadonlySet<string>) {
  const shown = contractEntries(row).filter((entry) => codes.has(entry.code));
  return shown.length ? Object.fromEntries(shown.map((entry) => [entry.key, entry.value])) : null;
}

/**
 * 合同变更逐行编码的可见集（§4.5）：节点 / 查看权上有容器 `transferItems.contractChange`，且合同对象的查看权、
 * 该行目标合同的范围与合同字段查看权都通过（foreign-fields.ts）；目标合同查不到归属时视为不可见（fail-closed）。
 */
export async function visibleContractCodes(
  tx: Tx,
  tenantId: string,
  disclosure: Disclosure,
  rows: readonly TransferItem[],
): Promise<Set<string>> {
  const visible = new Set<string>();
  if (!canSee(disclosure.fields, ORG_ADJUSTMENT_CONTRACT_CONTAINER)) return visible;
  const owners = await contractOwners(tx, tenantId, rows);
  for (const row of rows) {
    const owner = row.linkage?.contract ? owners.get(row.linkage.contract.targetId) : undefined;
    if (!owner) continue;
    for (const entry of contractEntries(row)) {
      const field = {
        code: entry.code,
        container: ORG_ADJUSTMENT_CONTRACT_CONTAINER,
        objectCode: CONTRACT_OBJECT,
        field: entry.field,
        ...owner,
      };
      if (await disclosure.foreign(field)) visible.add(entry.code);
    }
  }
  return visible;
}
