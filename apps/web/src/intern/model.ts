import {
  EMPLOYEE_STATUS_LABELS,
  expectedProbationEndDate,
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
/** 恢复槽集合（slot.ts）：同一员工的直接操作及申请提交 / 撤回 / 撤销共用员工 id，防止换入口绕开未知锁。 */
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
/** 由本单写后详情的状态确定目的视图，列表定位不承担写结果确认。 */
export interface ApplicationDestination {
  id: string;
  view: 'converting' | 'converted';
}

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

export type Entry = 'regularize' | 'apply' | 'terminate' | 'withdraw' | 'revoke';
/**
 * 详情顶部入口（补证 R2d / R2f1）：读接口没有逐行动作（同 F-268），按服务端视图归属、单据状态与权限快照里的
 * 对象操作和按钮显示；资格（在职实习生、在途申请、原发起人）由服务端在提交时判定。
 * 实习转正中的人仍是实习生：可直接转正（DEC-593 自动作废在途申请）与结束实习。
 * F-285（03 修订验收①）：申请仅实习中且状态允许，复用本处推导；逐行动作由 F-283 后续统一接线。
 */
export function entriesFor(view: InternView, row: Row, p: ObjectPermission | undefined): Entry[] {
  if (!p || !validObject({ id: row.employeeId, revision: 0 })) return [];
  const can = (code: string) => canButton(p, code, 'detail');
  const create = !!p.dataOperations.create;
  const update = !!p.dataOperations.update;
  const intern = view === 'interning' || view === 'converting';
  const reviewing =
    view === 'converting' && row.state === 'in_review' && validObject({ id: row.id, revision: row.revision });
  const regularize = intern && create && can('Employment.Create');
  const entries: [Entry, boolean][] = [
    ['regularize', regularize],
    ['apply', regularize && view === 'interning' && row.state === 'effective' && update && can('Employment.Submit')],
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
    if (isBlank(values[field])) invalidField(field, m.required(m.labels[field]!));
  }
  if (values.probation !== true) return;
  const months = values.probationMonths;
  if (!Number.isInteger(months) || Number(months) < PROBATION_MONTHS_MIN || Number(months) > PROBATION_MONTHS_MAX)
    invalidField('probationMonths', m.invalidMonths);
  if (String(values.probationEndDate) < String(values.effectiveDate)) invalidField('probationEndDate', m.invalidEnd);
}

function invalidField(field: string, message: string): never {
  throw new ApiError(400, 'VALIDATION_FAILED', 'fields', message, {
    details: { fieldErrors: { [field]: [message] } },
  });
}

/** 直接转正与申请共用：变更日期 / 月数时推算，可手改；关闭试用期清除隐藏值。 */
export function probationChanges(changed: Values, all: Values): Values {
  if (changed.probation === false) return { probationMonths: null, probationEndDate: null };
  if (!('effectiveDate' in changed || 'probationMonths' in changed) || all.probation !== true) return {};
  const { effectiveDate, probationMonths } = all;
  return typeof effectiveDate === 'string' &&
    Number.isInteger(probationMonths) &&
    Number(probationMonths) >= 1 &&
    Number(probationMonths) <= 6
    ? { probationEndDate: expectedProbationEndDate(effectiveDate, Number(probationMonths)) }
    : { probationEndDate: null };
}

/** DirectError 保留后端 reason；本地 ApiError 和服务端字段数组统一映射到原字段。 */
export function regularizeFieldErrors(error: unknown) {
  if (error instanceof ApiError && error.fieldErrors.length) return error.fieldErrors;
  const failure = error as { details?: Values; message?: string } | undefined;
  const fields: Record<string, string> = {
    PROBATION_REQUIRED: 'probation',
    PROBATION_MONTHS_REQUIRED: 'probationMonths',
    PROBATION_END_BEFORE_START: 'probationEndDate',
  };
  const field = fields[String(failure?.details?.reason)];
  if (field) return [{ name: [field], errors: [failure!.message ?? m.required(m.labels[field]!)] }];
  const details = failure?.details;
  return Array.isArray(details)
    ? details.flatMap((issue: { path?: string[]; message?: string }) =>
        issue.path?.length && issue.message ? [{ name: issue.path, errors: [issue.message] }] : [],
      )
    : [];
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
/** 通用申请先创建 draft，再按草稿 revision 提交审批（F-284 HTTP 契约）。 */
export function applicationBody(values: Values): Values {
  const { effectiveDate, probation, probationMonths, probationEndDate, ...fields } = regularizeBody(values);
  return {
    kind: 'intern_regularization',
    mode: 'application',
    effectiveDate,
    fields,
    probation,
    ...(probation ? { probationMonths, probationEndDate } : {}),
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
