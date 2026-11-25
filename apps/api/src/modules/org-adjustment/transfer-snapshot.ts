/**
 * 调动分区的审批快照（R2-T08 §4.5，BE-11c-b）：与组织分区同形——每个编码一份 `[{ itemId, value }]`，只列有值的行；
 * 合同变更展开为带明细身份的逐行编码 `transferItems.<itemId>.contractChange.<field>`（节点勾容器即展开，盲审按编码判，
 * 与行序无关）。“变更前”部门从基线任职记录取（`sourceDepartments`），不单独建列（硬规则 3）。
 */
import { CONTRACT_OBJECT, contractChangeFieldCode, ORG_ADJUSTMENT_CONTRACT_CONTAINER } from '@italent/domain';
import type { ForeignField } from '../approval/foreign-fields.js';
import { contractFieldEntries } from '../transfer/linkage/approval.js';
import type { ContractOwner, TransferItem } from './transfer-items-store.js';

type ItemValue = { readonly itemId: string; readonly value: unknown };
type Sections = {
  values: Record<string, ItemValue[]>;
  originals: Record<string, ItemValue[]>;
  /** 合同变更的逐行编码 → 合同对象字段（盲审与披露按合同对象的权限判，不在本单对象字段目录里）。 */
  foreignFields: ForeignField[];
};

const PREFIX = 'transferItems.';
const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0);

/** 行内容 → 静态编码取值；目标部门指向同单新增组织时写 `{ itemRef }`，与已有组织 ID 区分。 */
function staticValues(row: TransferItem): Record<string, unknown> {
  return {
    employeeId: row.employeeId,
    departmentId: row.departmentId ?? (row.departmentItemId ? { itemRef: row.departmentItemId } : null),
    positionId: row.positionId ?? (row.positionItemId ? { itemRef: row.positionItemId } : null),
    postId: row.postId,
    levelId: row.levelId,
    directManagerId: row.directManagerId,
    dutyTransfer: row.linkage?.dutyTransfer ?? null,
    trial: row.linkage?.onTrial ?? null,
    adjustSalary: row.linkage?.adjustSalary ?? false,
    withEstablishment: row.withEstablishment,
  };
}

/** 合同对象字段 → 逐行编码的字段段：目标合同 `id` 记作 `targetId`；自定义字段 `custom:<id>` 去掉非字母数字。 */
const codeField = (field: string) =>
  field === 'id'
    ? 'targetId'
    : field.startsWith('custom:')
      ? `custom${field.slice(7).replace(/[^A-Za-z0-9]/g, '')}`
      : field;

export interface ContractEntry {
  readonly code: string;
  /** 响应里的键（目标合同 `targetId`、标准字段名、`custom:<id>`）。 */
  readonly key: string;
  /** 合同对象上的字段编码（`id` / 标准字段 / `custom:<id>`）。 */
  readonly field: string;
  readonly value: unknown;
}

/** 合同变更逐行展开，与人工调动同一套字段口径（`contractFieldEntries`），只是编码带明细身份。 */
export function contractEntries(row: TransferItem): ContractEntry[] {
  const contract = row.linkage?.contract;
  if (!contract) return [];
  return contractFieldEntries(contract).map(([, field, value]) => ({
    code: contractChangeFieldCode(row.id, codeField(field)),
    key: field === 'id' ? 'targetId' : field,
    field,
    value,
  }));
}

export function transferSection(
  rows: readonly TransferItem[],
  sources: ReadonlyMap<string, string | null>,
  owners: ReadonlyMap<string, ContractOwner> = new Map(),
): Sections {
  const values: Sections['values'] = {};
  const originals: Sections['originals'] = {};
  const foreignFields: ForeignField[] = [];
  for (const row of rows) {
    const own = Object.fromEntries(Object.entries(staticValues(row)).map(([key, value]) => [PREFIX + key, value]));
    for (const [code, value] of Object.entries(own)) {
      if (isEmpty(value)) continue;
      (values[code] ??= []).push({ itemId: row.id, value });
    }
    const owner = row.linkage?.contract ? owners.get(row.linkage.contract.targetId) : undefined;
    for (const entry of contractEntries(row)) {
      // 显式 null / false 是清空或置否，同样改写合同，与人工调动口径一致（DEC-057 / 058）
      (values[entry.code] ??= []).push({ itemId: row.id, value: entry.value });
      // 目标合同查不到归属（已删）时不登记外部字段：fail-closed，视为不可见
      if (owner) {
        foreignFields.push({
          code: entry.code,
          container: ORG_ADJUSTMENT_CONTRACT_CONTAINER,
          objectCode: CONTRACT_OBJECT,
          field: entry.field,
          ...owner,
        });
      }
    }
    const source = sources.get(row.id);
    if (source) (originals[`${PREFIX}departmentId`] ??= []).push({ itemId: row.id, value: source });
  }
  return { values, originals, foreignFields };
}
