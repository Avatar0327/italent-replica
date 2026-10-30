import {
  ASSESSMENT_TYPES,
  EMPLOYEE_STATUS_LABELS,
  expectedProbationEndDate,
  PROBATION_MONTHS_MAX,
  PROBATION_MONTHS_MIN,
  PROBATION_VIEWS,
  type ProbationView,
} from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { canButton, type ObjectPermission } from '../foundation/permission-model.js';
import { DirectError } from '../part-time/direct-api.js';
import { m } from './messages.js';

export const object = 'TenantBase.EmploymentRecord';
export const personObject = 'TenantBase.Employee';
export const apiRoot = '/api/tenant/employment';
/** 恢复槽集合：同一员工的编辑试用期、转正、申请提交 / 撤回 / 撤销共用员工 id，换入口也绕不开未知锁。 */
export const employees = `${apiRoot}/employees`;
export const businesses = `${apiRoot}/businesses`;
export const regularizations = `${apiRoot}/regularizations`;
// 补证 B5：每页 15 条
export const pageSize = 15;
export const views = PROBATION_VIEWS.map((key) => ({ key, label: m.views[key] }));
export type { ProbationView };

const validObject = (item: { id?: unknown; revision?: unknown }) =>
  typeof item.id === 'string' && item.id !== '' && Number.isSafeInteger(item.revision) && Number(item.revision) >= 0;

/** GET /probation-views 的条目（probation-routes.ts）：任职字段与姓名 / 工号按可见字段裁剪后缺键，控制项总在。 */
type Dates = 'startDate' | 'expectedEndDate' | 'regularizationDate';
type References = 'departmentId' | 'organizationId' | 'postId' | 'regularizationBusinessId' | 'assessmentId';
type Codes = 'regularizationState' | 'regularizationMode' | 'probationResult' | 'assessmentType';
export interface Row extends Partial<Record<Dates | References | Codes, string | null>> {
  id: string;
  employeeId?: string;
  code?: string;
  name?: string;
  employeeStatus?: number;
  revision?: number;
  hasProbation?: boolean | null;
  months?: number | null;
}
export type ListResult = { items: Row[]; page: number; pageSize: number; hasDataPermission?: boolean };
export type Filters = Partial<
  Record<'keyword' | 'departmentId' | 'postId' | 'expectedEndFrom' | 'expectedEndTo', string>
>;

// 只有“已转正”的列序有补证（B5）；其余四视图列序 / 列宽未取证（PR“未验证”），只列接口投影里有的字段。
const base = ['name', 'code', 'departmentId', 'organizationId', 'postId'];
export const columns: Record<ProbationView, readonly string[]> = {
  expiring: [...base, 'startDate', 'months', 'expectedEndDate', 'employeeStatus'],
  assessing: [...base, 'assessmentType', 'startDate', 'expectedEndDate'],
  in_review: [...base, 'startDate', 'expectedEndDate', 'regularizationDate', 'regularizationState'],
  all: [...base, 'startDate', 'months', 'expectedEndDate', 'employeeStatus', 'regularizationDate'],
  regularized: [...base, 'startDate', 'regularizationDate', 'regularizationState'],
};

/**
 * 筛选控件按可见字段显示：人员（关键字）要姓名、工号都可见，部门 / 职务要任职字段可见；预计结束日是控制项。
 * 后端不按可见字段校验筛选参数，前端不让不可见字段进请求（claude_fe_rules d）。
 */
export function allowedFilters(filters: Filters, allowed: (key: keyof Filters) => boolean): Filters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key, value]) => !isBlank(value) && allowed(key as keyof Filters)),
  );
}

export function listPath(view: ProbationView, page: number, filters: Filters = {}): string {
  const query = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
  for (const [key, value] of Object.entries(filters)) if (!isBlank(value)) query.set(key, String(value));
  return `${apiRoot}/probation-views?${query}`;
}

const text = (input: unknown) =>
  typeof input === 'string' || typeof input === 'number' ? String(input) || m.missing : m.missing;
const labels: Record<string, Record<string, string>> = {
  regularizationState: m.states,
  regularizationMode: m.modes,
  assessmentType: ASSESSMENT_TYPES,
  employeeStatus: EMPLOYEE_STATUS_LABELS as Record<number, string>,
};

/** 被裁剪的字段缺键，单元格显示占位，不拿别的字段拼值。 */
export function cellValue(row: object, key: string): string {
  const value = (row as Values)[key];
  if (typeof value === 'boolean') return value ? m.yes : m.no;
  return labels[key]?.[String(value)] ?? text(value);
}

export type Entry = 'edit' | 'regularize' | 'apply' | 'withdraw' | 'revoke' | 'assessment';
/** 有转正业务（审批中 / 审批通过 / 生效）就不能再发起转正（PB-R9 互斥由服务端最终判定）。 */
const pending = (row: Row) => !!row.regularizationState;
/**
 * 入口：读接口没有逐行动作（同实习 / F-268），按视图、行上的转正控制项与权限快照推导；资格由服务端在提交时判定。
 * - 编辑试用期：对象编辑 + Employment.Edit（probation-routes.ts commandOnly）；考核中、转正审批中不显示（PB-R9）。
 * - 转正 / 转正申请：只在即将到期、全部试用员工两视图，有试用期且没有转正业务；申请另需编辑 + Employment.Submit。
 * - 撤回 / 撤销：转正审批中视图、审批中的转正单。考核中视图只读打开考核。
 */
export function entriesFor(view: ProbationView, row: Row, p: ObjectPermission | undefined): Entry[] {
  if (!p || !validObject({ id: row.employeeId, revision: row.revision })) return [];
  const can = (code: string) => canButton(p, code, 'detail');
  const create = !!p.dataOperations.create;
  const update = !!p.dataOperations.update;
  const open = (view === 'expiring' || view === 'all') && row.hasProbation === true && !pending(row);
  const regularize = open && create && can('Employment.Create');
  const reviewing =
    view === 'in_review' && row.regularizationState === 'in_review' && typeof row.regularizationBusinessId === 'string';
  const entries: [Entry, boolean][] = [
    ['edit', !['assessing', 'in_review'].includes(view) && update && can('Employment.Edit')],
    ['regularize', regularize],
    ['apply', regularize && update && can('Employment.Submit')],
    ['withdraw', reviewing && update && can('Employment.Withdraw')],
    ['revoke', reviewing && update && can('Employment.Revoke')],
    ['assessment', view === 'assessing' && typeof row.assessmentId === 'string'],
  ];
  return entries.filter(([, shown]) => shown).map(([entry]) => entry);
}

export const probationPath = (employeeId: string) => `${employees}/${encodeURIComponent(employeeId)}/probation`;
export const adjustFields = ['hasProbation', 'startDate', 'months', 'expectedEndDate', 'regularizationDate'];
export const regularizeFields = ['effectiveDate', 'probationResult'];
export const monthOptions = Array.from(
  { length: PROBATION_MONTHS_MAX - PROBATION_MONTHS_MIN + 1 },
  (_, index) => PROBATION_MONTHS_MIN + index,
);

/** GET /employees/:id/probation（probation.ts probationDetail）核对员工与 revision，投影成编辑基线（同 409 重读）。 */
export function probationValues(raw: unknown, employeeId: string): { revision: number; values: Values } {
  const detail = raw as Values | null;
  if (detail?.employeeId !== employeeId || !Number.isSafeInteger(detail.revision)) throw new Error(m.invalidReceipt);
  const values = Object.fromEntries(adjustFields.map((key) => [key, detail[key] ?? null]));
  return { revision: Number(detail.revision), values };
}

/** 本地校验在提交前抛出（ConflictCommands：send 里抛的错会被判为结果未知）。 */
export function validateAdjust(values: Values) {
  if (typeof values.hasProbation !== 'boolean') invalidField('hasProbation', m.required(m.fields.hasProbation!));
  if (values.hasProbation !== true) return;
  for (const field of ['startDate', 'expectedEndDate'])
    if (isBlank(values[field])) invalidField(field, m.required(m.fields[field]!));
  const months = values.months;
  const valid =
    Number.isInteger(months) && Number(months) >= PROBATION_MONTHS_MIN && Number(months) <= PROBATION_MONTHS_MAX;
  if (!isBlank(months) && !valid) invalidField('months', m.invalidMonths);
  if (String(values.expectedEndDate) < String(values.startDate)) invalidField('expectedEndDate', m.invalidEnd);
}
export function validateRegularize(values: Values, dateRequired = true) {
  if (dateRequired && isBlank(values.effectiveDate))
    invalidField('effectiveDate', m.required(m.fields.regularizationDate!));
  if (isBlank(values.probationResult)) invalidField('probationResult', m.required(m.fields.probationResult!));
}
function invalidField(field: string, message: string): never {
  throw new ApiError(400, 'VALIDATION_FAILED', 'fields', message, {
    details: { fieldErrors: { [field]: [message] } },
  });
}

/** 改开始日期 / 月数时推算预计结束日（可手改，R2e6）；改为无试用期时清除隐藏值。 */
export function adjustChanges(changed: Values, all: Values): Values {
  if (changed.hasProbation === false) return { startDate: null, months: null, expectedEndDate: null };
  if (!('startDate' in changed || 'months' in changed) || all.hasProbation !== true) return {};
  const { startDate, months } = all;
  return typeof startDate === 'string' && Number.isInteger(months)
    ? { expectedEndDate: expectedProbationEndDate(startDate, Number(months)) }
    : {};
}

const nullable = (value: unknown) => (isBlank(value) ? null : value);
/** PUT /employees/:id/probation（probation-routes.ts adjustInput，严格体）。 */
export function adjustBody(values: Values): Values {
  const regularizationDate = nullable(values.regularizationDate);
  if (values.hasProbation !== true) return { hasProbation: false, regularizationDate };
  return {
    hasProbation: true,
    startDate: nullable(values.startDate),
    months: nullable(values.months),
    expectedEndDate: nullable(values.expectedEndDate),
    regularizationDate,
  };
}
/** 回执是去掉 records / recordId / entryDate 的试用详情：同一员工，revision 高于实际提交的版本。 */
export function acceptAdjust(raw: unknown, employeeId: string, sent: number) {
  const detail = raw as Values | null;
  if (
    detail?.employeeId !== employeeId ||
    typeof detail.hasProbation !== 'boolean' ||
    !Number.isSafeInteger(detail.revision) ||
    Number(detail.revision) <= sent ||
    'records' in detail
  )
    throw new Error(m.invalidReceipt);
  return Number(detail.revision);
}

export type Pinned = { employeeId: string; revision: number };
/** POST /regularizations（regularization.ts 严格体）：不带 If-Match，员工 revision 逐人放在 items 里。 */
export function regularizationsBody(values: Values, items: readonly Pinned[]): Values {
  return {
    mode: 'direct',
    ...(isBlank(values.effectiveDate) ? {} : { effectiveDate: values.effectiveDate }),
    probationResult: values.probationResult,
    items: items.map(({ employeeId, revision }) => ({ employeeId, revision })),
  };
}
/** 通用入口建草稿（routes.ts createRegularizationViaBusinesses）：If-Match = 员工 revision。 */
export function applicationBody(values: Values): Values {
  return {
    kind: 'regularization',
    mode: 'application',
    effectiveDate: values.effectiveDate,
    probationResult: values.probationResult,
  };
}

export interface ReceiptItem {
  employeeId: string;
  status: 'succeeded' | 'failed';
  businessId: string | null;
  effectiveDate: string | null;
  businessStatus: string | null;
  error: { code: string; message: string; details?: unknown } | null;
}
const errorStatus: Record<string, number> = { REVISION_CONFLICT: 409, CONFLICT: 409, NOT_FOUND: 404, FORBIDDEN: 403 };
/**
 * 逐人回执（regularization.ts regularizeEmployees）：total 与提交人数一致、逐人与 items 同序同人；成功的人要有单据 ID。
 * 批量入口不论人数都按逐人回执展示：批量是多人命令，没有单一基线可重读核对，版本冲突也是这一人的失败，
 * 列出原因并刷新列表，用户重选后按最新版本再提交（P2-2）。
 */
export function regularizationReceipt(raw: unknown, items: readonly Pinned[]) {
  const receipt = raw as { total?: unknown; items?: ReceiptItem[] } | null;
  const rows = receipt?.items;
  if (
    receipt?.total !== items.length ||
    !Array.isArray(rows) ||
    rows.length !== items.length ||
    rows.some(
      (row, index) =>
        row?.employeeId !== items[index]!.employeeId ||
        (row.status === 'succeeded' ? typeof row.businessId !== 'string' : row.status !== 'failed' || !row.error),
    )
  )
    throw new Error(m.invalidReceipt);
  return {
    succeeded: rows.filter((row) => row.status === 'succeeded'),
    failed: rows.filter((row) => row.status === 'failed'),
  };
}
/**
 * 单人直接转正的回执：失败即整单未写，按该人的错误码抛出，内核判为拒绝（REVISION_CONFLICT 走冲突恢复，
 * 单人有员工详情可重读核对）。
 */
export function acceptRegularizations(raw: unknown, items: readonly Pinned[]) {
  const outcome = regularizationReceipt(raw, items);
  if (items.length === 1 && outcome.failed.length === 1) {
    const { code, message, details } = outcome.failed[0]!.error!;
    const reason = (details as Values | undefined)?.reason;
    throw new DirectError(errorStatus[code] ?? 400, code, message, reason ? { reason } : {});
  }
  return outcome;
}

/** 写后的目的视图：直接转正（含审批通过未到期）进“已转正”，申请提交后进“转正审批中”（PB-R1）。 */
const destinations: Record<string, ProbationView> = {
  in_review: 'in_review',
  approved: 'regularized',
  effective: 'regularized',
};
export const destinationOf = (status: unknown): ProbationView | undefined =>
  typeof status === 'string' && Object.hasOwn(destinations, status) ? destinations[status] : undefined;
