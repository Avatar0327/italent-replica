// F-329（DEC-705）：员工档案按原站三类入口分别编辑，不做整页编辑。
// 原站依据 docs/02_业务建模/17 补充「F-329 员工档案的编辑入口」；本文件只放入口判断、字段与回执核对。
import { EMPLOYEE_FIELDS, SUBSETS, buttonsOf, type PersonnelField, type SubsetKind } from '@italent/domain';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { validObject } from '../foundation/forms/ConflictCommands.js';
import { m } from './messages.js';

type Permission = ObjectPermission | undefined;
type Item = { id?: string; revision?: number; [field: string]: unknown };

/**
 * 「编辑人员」两节，按原站顺序只列复刻已有的字段；是否调整期、HRBP、导师、利润中心、飞书等复刻没有，
 * 租户自定义字段不做。日工资标准不进表单（DEC-705），人员类别归 F-323（DEC-706）。
 */
export const personInfoFields = [
  'name',
  'email',
  'workDate',
  'idType',
  'idNumber',
  'birthday',
  'gender',
  'mobilePhone',
] as const;
/** 任职信息节：入职日期、工号、人员状态由任职业务维护，只读展示；部门、职务、经理等走「编辑任职」。 */
export const personJobFields = [
  'entryDate',
  'code',
  'expectedRetirementDate',
  'expectedRetirementConfirmed',
  'employeeStatus',
] as const;
/** 任职记录可在「编辑任职」里改的字段：工号须等于员工 ID、用工形式等归 F-323，均不进表单。 */
export const recordFields = [
  'departmentId',
  'positionId',
  'postId',
  'directManagerId',
  'dottedManagerId',
  'place',
  'remarks',
] as const;
/** 本单位经历由任职记录同步，这些字段后端拒绝修改（apps/api/src/modules/personnel/subsets.ts）。 */
const syncedJobHistory = new Set([
  'company',
  'department',
  'departmentFullName',
  'post',
  'position',
  'level',
  'startDate',
  'endDate',
  'entryDate',
  'leaveDate',
  'employmentType',
  'employmentRecordId',
  'isThisCompany',
]);
/** 离职 / 退休记录另需各自的编辑按钮（R2-T03 §4A、R2-T04 §3.1，后端 record-edit.ts requireExitPermission）。 */
const exitKinds = new Set(['leave', 'retirement']);
const writablePerson = new Set(EMPLOYEE_FIELDS.filter((field) => !field.system).map((field) => field.code));

const granted = (p: Permission, operation: string, button: string, level: string): p is ObjectPermission =>
  !!p && !p.summary && p.dataOperations[operation] === true && canButton(p, button, level);

export function personEditable(p: Permission): string[] {
  if (!granted(p, 'update', 'update', 'detail')) return [];
  return [...personInfoFields, ...personJobFields].filter(
    (name) => writablePerson.has(name) && fieldAccess(p, name).editable,
  );
}

export function subsetFields(kind: SubsetKind): readonly PersonnelField[] {
  return SUBSETS[kind].fields;
}

/**
 * 工作履历行是否可能由任职同步：后端手工行的标识落库为 null / false；字段被查看权裁掉（键缺失）时不知道，
 * 按同步处理，免得把本单位经历当手工行放开改删（后端仍会拒绝，但入口不该出现）。
 */
const maybeSynced = (kind: SubsetKind, row: Item) =>
  kind === 'jobhistory' && (!Object.hasOwn(row, 'isThisCompany') || row.isThisCompany === true);

/** 新增要列表级 create 按钮，编辑要详情级 update 按钮；附件（uuid）与系统字段不进表单。 */
export function subsetEditable(p: Permission, kind: SubsetKind, mode: 'create' | 'update', row?: Item): string[] {
  if (!granted(p, mode, mode, mode === 'create' ? 'list' : 'detail')) return [];
  const synced = row !== undefined && maybeSynced(kind, row);
  return subsetFields(kind)
    .filter((field) => !field.system && field.kind !== 'uuid' && m.labels[field.code])
    .filter((field) => !(synced && syncedJobHistory.has(field.code)) && fieldAccess(p, field.code).editable)
    .map((field) => field.code);
}

export function canDeleteSubset(p: Permission, kind: SubsetKind, row: Item) {
  return granted(p, 'delete', 'delete', 'detail') && !maybeSynced(kind, row) && validObject(row);
}

/**
 * 「编辑任职」要 Employment.Edit；离职记录还要 DimissionEdit，退休记录要 RetireEdit（独立授权，不复用 Dimission*）。
 * 业务类型被裁剪或不认识时无法确定要哪个按钮，不放入口。
 */
export function recordEditable(p: Permission, record: Item): string[] {
  if (!granted(p, 'update', 'Employment.Edit', 'detail') || !validObject(record)) return [];
  if (record.status !== undefined && record.status !== 'effective') return [];
  const kind = record.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(m.kinds, kind)) return [];
  if (exitKinds.has(kind) && !canButton(p, buttonsOf(kind).edit, 'detail')) return [];
  return recordFields.filter((name) => fieldAccess(p, name).editable);
}

/** 任职编辑请求体按后端 normalizeBusinessPatch：预置字段包在 fields 里。 */
export const recordBody = (edited: Record<string, unknown>) => ({ fields: edited });

const reject = (): never => {
  throw new Error(m.editing.badReceipt);
};
function object(raw: unknown) {
  if (!raw || typeof raw !== 'object') reject();
  return raw as Record<string, unknown>;
}

/** 人员 PATCH 回整份人员 DTO：同一员工、版本恰好 +1。 */
export function personReceipt(raw: unknown, sent: { id: string; revision: number }) {
  const body = object(raw);
  if (body.id !== sent.id || body.revision !== sent.revision + 1) reject();
  return { id: sent.id };
}

/**
 * 子集写入回整行：新增 0 → 1 带新 id；编辑 / 删除同 id、n → n + 1。回执按查看权裁剪（personnel/http.ts write → trim），
 * 删除时 deleted 常被裁掉：缺键时以成功状态码 + 同 id、版本 +1 确认；可见时须为 true。
 */
export function subsetReceipt(raw: unknown, sent: { id?: string; revision: number; deleted?: boolean }) {
  const body = object(raw);
  if (typeof body.id !== 'string' || !body.id || (sent.id !== undefined && body.id !== sent.id)) reject();
  if (body.revision !== sent.revision + 1) reject();
  if (sent.deleted && Object.hasOwn(body, 'deleted') && body.deleted !== true) reject();
  return { id: body.id as string };
}

/** 任职 PATCH 回任职业务 DTO：同一记录；字段没有实际变化时后端不加版本，所以只要求不低于提交版本。 */
export function recordReceipt(raw: unknown, sent: { id: string; revision: number }) {
  const body = object(raw);
  if (body.id !== sent.id || !Number.isSafeInteger(body.revision) || (body.revision as number) < sent.revision)
    reject();
  return { id: sent.id };
}

export function personFieldKind(name: string) {
  return EMPLOYEE_FIELDS.find((field) => field.code === name)?.kind;
}
