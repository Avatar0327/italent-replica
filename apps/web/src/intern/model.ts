import {
  EMPLOYEE_STATUS_LABELS,
  EXIT_BUTTONS,
  INTERN_VIEWS,
  PROBATION_MONTHS_MAX,
  PROBATION_MONTHS_MIN,
  type InternView,
} from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { isBlank, projectFields, type Values } from '../foundation/forms/values.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export const object = 'TenantBase.EmploymentRecord';
export const personObject = 'TenantBase.Employee';
export const apiRoot = '/api/tenant/employment';
/** 恢复槽集合（slot.ts）：三个入口都按员工 id 落在这里，申请单的提交 / 撤回 / 撤销按申请 id 落在 businesses。 */
export const interns = `${apiRoot}/interns`;
export const businesses = `${apiRoot}/businesses`;
export const pageSize = 30;
/**
 * 对象标识与 revision 可用（口径同 ConflictCommands validObject）。纯模型不引 TSX：根 tsconfig 不开 JSX，
 * 单测直接引本文件（P2-3）。
 */
const validObject = (item: { id?: string; revision?: number }) =>
  typeof item.id === 'string' && item.id !== '' && Number.isSafeInteger(item.revision) && (item.revision ?? -1) >= 0;
export const views = INTERN_VIEWS.map((key) => ({ key, label: m.views[key] }));
export type { InternView };

/** GET /interns 的条目（intern-views.ts InternViewItem），字段按可见字段裁剪后可能缺键。 */
export interface Row {
  id: string;
  employeeId?: string;
  code?: string;
  name?: string;
  kind?: string;
  effectiveDate?: string;
  entryDate?: string | null;
  departmentId?: string | null;
  positionId?: string | null;
  employeeStatus?: number;
  revision?: number;
  state?: string;
  lastWorkDate?: string | null;
  probation?: { startDate?: string; months?: number; endDate?: string } | null;
}
export interface ListResult {
  items: Row[];
  page: number;
  pageSize: number;
  hasDataPermission?: boolean;
}
export interface Filters {
  keyword?: string;
  departmentId?: string;
}

// 原站四视图列序 / 列宽未取证（PR“未验证”）：只列后端 internViews 投影里有的字段。
const base = ['name', 'code', 'departmentId', 'positionId'];
export const columns: Record<InternView, readonly string[]> = {
  interning: [...base, 'entryDate', 'employeeStatus'],
  converting: [...base, 'effectiveDate', 'state'],
  converted: [...base, 'effectiveDate', 'employeeStatus', 'probationStartDate', 'probationMonths', 'probationEndDate'],
  left: [...base, 'entryDate', 'lastWorkDate'],
};

/** 关键字要姓名、工号都可见，部门筛选要部门可见（intern-routes.ts requireViewableInternFilters）；不可见的不进请求。 */
export function allowedFilters(filters: Filters, allowed: (key: keyof Filters) => boolean): Filters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key, value]) => !isBlank(value) && allowed(key as keyof Filters)),
  );
}

export function listPath(view: InternView, page: number, filters: Filters = {}): string {
  const query = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
  for (const [key, value] of Object.entries(filters)) if (!isBlank(value)) query.set(key, String(value));
  return `${interns}?${query}`;
}

const text = (input: unknown) =>
  typeof input === 'string' || typeof input === 'number' ? String(input) || m.missing : m.missing;

/** 被裁剪的字段缺键，单元格显示占位，不拿别的字段拼值（claude_fe_rules d）。 */
export function cellValue(row: Row, key: string): string {
  const probation = { probationStartDate: 'startDate', probationMonths: 'months', probationEndDate: 'endDate' };
  if (key in probation) return text(row.probation?.[probation[key as keyof typeof probation] as 'startDate']);
  if (key === 'state') return m.states[String(row.state)] ?? text(row.state);
  if (key === 'employeeStatus')
    return (EMPLOYEE_STATUS_LABELS as Record<number, string>)[Number(row.employeeStatus)] ?? text(row.employeeStatus);
  return text(row[key as keyof Row]);
}

export type Entry = 'regularize' | 'terminate' | 'withdraw' | 'revoke';
/**
 * 详情顶部入口（补证 R2d / R2f1）：读接口没有逐行动作（同 F-268），按服务端视图归属、单据状态与权限快照里的
 * 对象操作和按钮显示；资格（在职实习生、在途申请、原发起人）由服务端在提交时判定。
 * 实习转正中的人仍是实习生：可直接转正（DEC-593 自动作废在途申请）与结束实习。
 * DEC-647：不开放“实习转正申请”（HR 只用直接转正；申请入口与试用期区由 F-285 后补），
 * 实习转正中已有的审批中申请仍可撤回 / 撤销。
 */
export function entriesFor(view: InternView, row: Row, p: ObjectPermission | undefined): Entry[] {
  if (!p || !validObject({ id: row.employeeId, revision: 0 })) return [];
  const can = (code: string) => canButton(p, code, 'detail');
  const create = !!p.dataOperations.create;
  const update = !!p.dataOperations.update;
  const intern = view === 'interning' || view === 'converting';
  const reviewing =
    view === 'converting' && row.state === 'in_review' && validObject({ id: row.id, revision: row.revision });
  const entries: [Entry, boolean][] = [
    ['regularize', intern && create && can('Employment.Create')],
    ['terminate', intern && create && can(EXIT_BUTTONS.direct)],
    ['withdraw', reviewing && update && can('Employment.Withdraw')],
    ['revoke', reviewing && update && can('Employment.Revoke')],
  ];
  return entries.filter(([, shown]) => shown).map(([entry]) => entry);
}

/** 表单字段：试用期三项是服务端控制项（policy.ts controls），随对象“新增”操作可写；其余按字段权限。 */
export const probationFields = ['probation', 'probationMonths', 'probationEndDate'];
const reportingFields = ['positionId', 'directManagerId', 'dottedManagerId'];
const recordFields = ['effectiveDate', 'departmentId', ...reportingFields];
export const formFields = [...recordFields, ...probationFields];
export const terminateFields = ['endDate', 'cancelPendingEntry'];
/** 服务端控制项（不在字段目录里）：不按字段权限，随对象“新增”操作可写、总是显示。 */
export const controlFields = [...probationFields, ...terminateFields];
export const monthOptions = Array.from(
  { length: PROBATION_MONTHS_MAX - PROBATION_MONTHS_MIN + 1 },
  (_, index) => PROBATION_MONTHS_MIN + index,
);

export function editableFields(fields: readonly string[], p: ObjectPermission | undefined): string[] {
  const create = !!p?.dataOperations.create;
  return fields.filter((field) => create && (controlFields.includes(field) || fieldAccess(p, field).editable));
}

/**
 * 打开基线（与 409 重读同一投影）：部门、职位、汇报关系取当前主职任职（records 的 fields，按可见字段裁剪后缺键为空），
 * 转正日期为空，默认有试用期（补证 R2f1）。默认带出的值就是基线，用户没改就不算修改。
 */
export function openingValues(record?: Values): Values {
  return {
    effectiveDate: null,
    ...projectFields(record?.fields as Values | undefined, ['departmentId', ...reportingFields]),
    probation: true,
    probationMonths: null,
    probationEndDate: null,
  };
}
export const terminateOpening = (): Values => ({ endDate: null, cancelPendingEntry: false });

/** 本地校验在提交前抛出（ConflictCommands：send 里抛的错会被判为结果未知）。 */
export function validateRegularize(values: Values, editable: readonly string[]) {
  const terms = values.probation === true ? ['probationMonths', 'probationEndDate'] : [];
  const required = ['effectiveDate', 'departmentId', 'probation', ...terms];
  for (const field of required) {
    if (!editable.includes(field)) throw new ApiError(403, 'FORBIDDEN', 'forbidden', m.denied);
    if (isBlank(values[field])) throw new ApiError(400, 'VALIDATION_FAILED', 'fields', m.required(m.labels[field]!));
  }
}

const present = (values: Values, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => !isBlank(values[key])).map((key) => [key, values[key]]));

/** POST /interns/:id/regularize（intern-regularization.ts internRegularizationInput，严格体）。 */
export function regularizeBody(values: Values): Values {
  const probation = values.probation === true;
  return {
    ...present(values, ['effectiveDate', 'departmentId', ...reportingFields]),
    probation,
    ...(probation ? present(values, ['probationMonths', 'probationEndDate']) : {}),
  };
}
/** POST /interns/:id/terminate（intern-termination.ts）：开关默认关，只有打开时才发。 */
export function terminateBody(values: Values): Values {
  return { endDate: values.endDate, ...(values.cancelPendingEntry === true ? { cancelPendingEntry: true } : {}) };
}

/**
 * 回执按真实返回（EmploymentBusiness）核对：同一员工、同一业务类型；新建类命令会把员工 revision 加一，
 * 按实际提交的 command.revision 判定（claude_fe_rules a）。单据命令（提交 / 撤回 / 撤销）核对单据 id 与 revision。
 */
export function acceptBusiness(
  value: unknown,
  expected: { employeeId: string; kind: string; sent: number; id?: string },
): Values {
  const row = value as Values | null | undefined;
  const revision = expected.id ? row?.revision : row?.employeeRevision;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    (expected.id !== undefined && row.id !== expected.id) ||
    row.employeeId !== expected.employeeId ||
    row.kind !== expected.kind ||
    !Number.isSafeInteger(row.revision) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) <= expected.sent
  )
    throw new Error(m.invalidReceipt);
  return row;
}

export interface Confirmation {
  message: string;
  /** 确认后随同一命令上下文重提时追加到请求体的确认项。 */
  extra: Values;
  /** 后端提示有审批通过、尚未生效的实习转正（待入职）：显示“离职同步取消待入职”（31 IN-R8）。 */
  pendingEntry: boolean;
}
/**
 * 服务端要求二次确认的 409：超编 / 在途转正（CONFIRMATION_REQUIRED → confirmed）、在途调动或考核
 * （EXIT_*_ACK_REQUIRED → pendingTransferAck，沿用离职 §8 令牌）。其余 409 是确定的拒绝。
 */
export function confirmationOf(error: unknown): Confirmation | undefined {
  const failure = error as { status?: number; message?: string; details?: Values } | null;
  const details = failure?.details;
  if (failure?.status !== 409 || !details) return undefined;
  const message = String(failure.message ?? m.confirmTitle);
  const warnings = Array.isArray(details.warnings) ? (details.warnings as Values[]) : [];
  if (details.reason === 'CONFIRMATION_REQUIRED')
    return { message, extra: { confirmed: true }, pendingEntry: warnings.some((item) => item.state === 'approved') };
  const ack = ['EXIT_PENDING_TRANSFER_ACK_REQUIRED', 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED'];
  if (ack.includes(String(details.reason)) && typeof details.ackToken === 'string')
    return { message, extra: { pendingTransferAck: details.ackToken }, pendingEntry: false };
  return undefined;
}
