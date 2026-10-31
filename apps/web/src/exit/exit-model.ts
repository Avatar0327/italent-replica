/**
 * 离职管理（FE-R2c2）的纯规则：列表投影、入口推导、提交前检查、请求体与回执校验。
 * 后端口径：employment/exit-routes.ts（GET /exits、详情、新建、PATCH、撤销）、exit-preview.ts、exit-handover*.ts。
 * 本文件不依赖 React，单测直接引用；资格与校验的权威仍在服务端。
 */
import {
  BLACKLIST_REASONS,
  EXIT_BUTTONS,
  HANDOVER_BATCH_SUBMIT_BUTTON as BATCH,
  HANDOVER_RESUBMIT_BUTTON as RESUBMIT,
  HANDOVER_ROW_SUBMIT_BUTTON as ROW_SUBMIT,
  HANDOVER_SUBMIT_BUTTON as SUBMIT,
} from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { x } from './messages.js';

export const apiRoot = '/api/tenant/employment';
export const exits = `${apiRoot}/exits`;
/** 新建按员工钉恢复槽（If-Match = 员工 revision）；单据命令按离职单 id。 */
export const exitEmployees = `${exits}/employees`;
export const handoverRequests = `${apiRoot}/exit-handover-requests`;
export const pageSize = 30;
export const BATCH_LIMIT = 100;
export const object = 'TenantBase.EmploymentRecord';
export const personObject = 'TenantBase.Employee';
export const TOO_MANY = 'EXIT_APPLICATIONS_TOO_MANY';

export const VIEWS = ['in_progress', 'completed', 'all'] as const;
export type ExitView = (typeof VIEWS)[number];
export const isView = (value: unknown): value is ExitView => VIEWS.includes(value as ExitView);

/** GET /exits 条目（trimExit + rowActions）：被裁剪的键直接缺席。 */
export interface Row {
  id: string;
  employeeId?: string;
  name?: string;
  status?: string;
  revision?: number;
  rowActions?: string[];
  [key: string]: unknown;
}
export type ListResult = { items: Row[]; total: number; page: number; pageSize: number; hasDataPermission?: boolean };
export type Filters = { keyword?: string; departmentId?: string };

// 原站列序 / 列宽未取证（PR“未验证”）：只列后端 trimExit 投影里有的字段。
const base = ['name', 'code', 'departmentId', 'positionId', 'lastWorkDate', 'effectiveDate', 'exitTypeCode'];
export const columns: Record<ExitView, readonly string[]> = {
  in_progress: [...base, 'reasonCode', 'mode', 'status'],
  completed: [...base, 'reasonCode', 'whereaboutsCode'],
  all: [...base, 'reasonCode', 'mode', 'status'],
};

/** 只有可见的筛选进请求（exit-routes.ts 筛选依赖：关键字 = 姓名 + 工号，部门 = departmentId）。 */
export function allowedFilters(filters: Filters, allowed: (key: keyof Filters) => boolean): Filters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key, value]) => !isBlank(value) && allowed(key as keyof Filters)),
  );
}
export function listPath(view: ExitView, page: number, filters: Filters = {}) {
  const query = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
  for (const [key, value] of Object.entries(filters)) if (!isBlank(value)) query.set(key, String(value));
  return `${exits}?${query}`;
}

const text = (value: unknown) =>
  (typeof value === 'string' && value) || typeof value === 'number' ? String(value) : x.missing;
const named: Record<string, string> = {
  exitTypeCode: 'exitTypeName',
  reasonCode: 'reasonName',
  whereaboutsCode: 'whereaboutsName',
};
/** 被裁剪的键显示占位，不拿别的字段拼值；字典项显示保存时的名称。 */
export function cellValue(row: Row, key: string): string {
  if (!(key in row)) return x.missing;
  if (key === 'status') return x.statuses[String(row.status)] ?? text(row.status);
  if (key === 'mode') return x.modes[String(row.mode)] ?? text(row.mode);
  if (named[key]) return text(row[named[key]] ?? row[key]);
  return text(row[key]);
}

const validObject = (id: unknown, revision: unknown) =>
  typeof id === 'string' && id !== '' && Number.isSafeInteger(revision) && Number(revision) >= 0;
/** 编辑 / 撤销的状态口径（exit-gate.ts 撤销可用状态；编辑同此，资格由服务端判）。 */
const OPEN_STATUSES = ['draft', 'in_review', 'approved', 'rejected', 'effective'];
const HANDOVER_STATUSES = ['in_review', 'approved', 'effective'];
const IN_PROGRESS_STATUSES = ['draft', 'in_review', 'approved', 'rejected'];

const pick = <T extends keyof typeof EXIT_BUTTONS>(p: ObjectPermission, entries: readonly T[]) =>
  entries.filter((entry) => canButton(p, EXIT_BUTTONS[entry], 'detail'));
/** 工具栏入口：新增操作 + 对应按钮（exit-gate.ts permissionSpec create）。 */
export const createEntries = (p: ObjectPermission | undefined) =>
  p?.dataOperations.create ? pick(p, ['application', 'direct'] as const) : [];

/**
 * 详情动作：读接口没有逐单动作（同 F-268），按单据状态与权限快照推导；restore 后端一律拒绝，不提供。
 * 状态被裁剪或单据标识无效时不给任何写入口。
 */
export function detailEntries(row: Row, p: ObjectPermission | undefined): ('edit' | 'cancel')[] {
  if (!p?.dataOperations.update || !validObject(row.id, row.revision)) return [];
  return OPEN_STATUSES.includes(String(row.status)) ? pick(p, ['edit', 'cancel'] as const) : [];
}

/**
 * 行内动作：发起交接只认服务端 rowActions；“离职处理”（B15，办理结果未验证）按直接离职权限，
 * 只给当前没有在途 / 已生效离职单的行（在途的人服务端会以 EXIT_IN_PROGRESS 拦下）。
 */
export function rowEntries(row: Row, p: ObjectPermission | undefined): ('handover' | 'handle')[] {
  const entries: ('handover' | 'handle')[] = [];
  if (validObject(row.id, row.revision) && row.rowActions?.includes(ROW_SUBMIT.code)) entries.push('handover');
  const settled = typeof row.status === 'string' && ![...IN_PROGRESS_STATUSES, 'effective'].includes(row.status);
  if (settled && typeof row.employeeId === 'string' && createEntries(p).includes('direct')) entries.push('handle');
  return entries;
}
/** 批量发起交接：列表级按钮有权，且只对带行动作的行（服务端逐条复核）。 */
export const batchHandoverRows = (rows: readonly Row[], p: ObjectPermission | undefined) =>
  canButton(p, BATCH.code, BATCH.level) ? rows.filter((row) => rowEntries(row, p).includes('handover')) : [];

/** GET /exits/:id/handover（exit-handover-routes）。 */
export type HandoverItem = { id: string; category?: string; sequenceNo?: number; title?: string; done?: boolean };
export interface Handover {
  status: string;
  request: null | {
    id: string;
    status: string;
    hint?: string | null;
    notLaunchedReason?: string | null;
    revision: number;
    items: HandoverItem[];
  };
}
export function parseHandover(raw: unknown): Handover {
  const value = raw as Partial<Handover> | null;
  const request = value?.request;
  if (typeof value?.status !== 'string' || request === undefined) throw new Error(x.invalidReceipt);
  if (request && (!validObject(request.id, request.revision) || !Array.isArray(request.items)))
    throw new Error(x.invalidReceipt);
  return value as Handover;
}
/** 首次发起：未发起 + 单据在审 / 通过 / 生效 + 详情按钮；重新提交：未发起成功 / 已终止 + 重新提交按钮。 */
export function handoverEntries(row: Row, handover: Handover | undefined, p: ObjectPermission | undefined) {
  if (!handover || !p?.dataOperations.update) return [];
  const entries: ('submit' | 'resubmit')[] = [];
  if (
    handover.status === 'not_started' &&
    !handover.request &&
    validObject(row.id, row.revision) &&
    HANDOVER_STATUSES.includes(String(row.status)) &&
    canButton(p, SUBMIT.code, SUBMIT.level)
  )
    entries.push('submit');
  const status = handover.request?.status;
  if ((status === 'not_launched' || status === 'terminated') && canButton(p, RESUBMIT.code, RESUBMIT.level))
    entries.push('resubmit');
  return entries;
}

/** F-240：详情的生效失败原因（activation.reason，或命令 409 的 details.activationFailure）。 */
export function activationNotice(source: Row | Values | undefined): string | undefined {
  const failure = (source?.activationFailure ?? source?.activation) as
    { reason?: unknown; detail?: Values; details?: Values } | null | undefined;
  if (failure?.reason !== TOO_MANY) return undefined;
  // 详情投影未登记 details.limit（会被裁掉），有就显示，没有只显示原因
  return x.activationTooMany((failure.detail ?? failure.details)?.limit);
}

/** POST /exits/employees/:id/preview 返回（exit-preview.ts previewExit）。 */
export interface Preview {
  lastWorkDate: string;
  blockers: { reason: string }[];
  ack: { ackToken: string } | null;
  warnings: { reason: string; limit?: number; items?: unknown[]; hiddenCount?: number }[];
}
export function parsePreview(raw: unknown, lastWorkDate: string): Preview {
  const value = raw as Partial<Preview> | null;
  if (
    value?.lastWorkDate !== lastWorkDate ||
    !Array.isArray(value.blockers) ||
    !Array.isArray(value.warnings) ||
    (value.ack !== null && typeof value.ack?.ackToken !== 'string')
  )
    throw new Error(x.invalidReceipt);
  return value as Preview;
}
const counted = (warning: Preview['warnings'][number]) =>
  (Array.isArray(warning.items) ? warning.items.length : 0) + (Number(warning.hiddenCount) || 0);
/**
 * 提交前检查的展示：blockers 挡提交；超上限（F-240）后端不给令牌，只提示上限，提交按钮是“继续提交”，
 * 不出现“确认并提交”，也不带令牌；有令牌时按钮为“确认并提交”，令牌放进 exit.pendingTransferAck。
 */
export function previewNotice(preview: Preview) {
  const blockers = preview.blockers.map((item) => x.blockers[item.reason] ?? item.reason);
  const tooMany = preview.warnings.find((item) => item.reason === TOO_MANY);
  const messages: string[] = [];
  for (const warning of preview.warnings) {
    const count = counted(warning);
    if (warning.reason === TOO_MANY) messages.push(x.tooMany(warning.limit));
    else if (warning.reason === 'EXIT_APPLICATIONS_TO_VOID' && count) messages.push(x.toVoid(count));
    else if (warning.reason === 'EXIT_FUTURE_TRANSFER_LANDED' && count) messages.push(x.landed(count));
    else if (warning.reason === 'IN_FLIGHT_ASSESSMENT' && count) messages.push(x.assessment(count));
  }
  const ackToken = tooMany ? undefined : preview.ack?.ackToken;
  // 超上限时没有令牌，“确认并提交”只在有令牌时出现
  const plain = tooMany ? x.continueSubmit : x.submit;
  return { blockers, messages, ackToken, tooMany: !!tooMany, label: ackToken ? x.confirmSubmit : plain };
}

/** 表单字段（exitOptionsSchema + lastWorkDate）；加黑三项只在“加入黑名单 = 是”时出现。 */
export const blacklistFields = ['blacklistExpiryDate', 'blacklistReason', 'blacklistNote'];
const codes = ['exitTypeCode', 'reasonCode', 'whereaboutsCode'];
export const formFields = ['lastWorkDate', ...codes, 'addToBlacklist', ...blacklistFields];
export const blacklistReasons = Object.entries(BLACKLIST_REASONS).map(([value, label]) => ({ value, label }));
/** 可编辑 = 对象操作 + 字段编辑权（exit-gate.ts 按载荷键校验字段）。 */
export function editableFields(p: ObjectPermission | undefined, operation: 'create' | 'update') {
  return p?.dataOperations[operation] ? formFields.filter((field) => fieldAccess(p, field).editable) : [];
}
/** 新建基线：加入黑名单默认“否”，其余为空。 */
export const openingValues = (): Values =>
  Object.fromEntries(formFields.map((field) => [field, field === 'addToBlacklist' ? false : null]));
/** 编辑基线取详情（trimExitDetail）：缺键（被裁剪）按空。 */
export const detailValues = (detail: Values): Values =>
  Object.fromEntries(Object.entries(openingValues()).map(([key, empty]) => [key, detail[key] ?? empty]));

function invalid(field: string, message: string): never {
  throw new ApiError(400, 'VALIDATION_FAILED', 'fields', message, {
    details: { fieldErrors: { [field]: [message] } },
  });
}
/**
 * 本地校验在命令前抛出（内核：send 里抛错会被判为结果未知）。新建：必填项须可编辑；
 * 编辑（带 baseline）：只校验可编辑项，原有的字典值不能清空（接口不接受 null）。
 */
export function validateExit(values: Values, editable: readonly string[], baseline?: Values) {
  for (const field of ['lastWorkDate', ...(values.addToBlacklist === true ? ['blacklistReason'] : [])]) {
    const allowed = editable.includes(field);
    if (!allowed && !baseline) throw new ApiError(403, 'FORBIDDEN', 'forbidden', x.denied);
    if (allowed && isBlank(values[field])) invalid(field, x.required(x.fields[field]!));
  }
  for (const field of baseline ? codes.filter((item) => editable.includes(item)) : [])
    if (isBlank(values[field]) && !isBlank(baseline![field])) invalid(field, x.noClear);
}

const present = (values: Values, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => key in values && !isBlank(values[key])).map((key) => [key, values[key]]));
const nullable = ['blacklistExpiryDate', 'blacklistNote'];
/**
 * 加黑三项只在加黑时发（服务端：只在 addToBlacklist 时可填）。clear = 改期 / 编辑：截止日期、说明清空发 null
 * （null = 永久 / 无说明）；新建时空值不发。字典编码不可为 null，清空由 validateExit 拦下。
 */
function exitOptions(values: Values, black: boolean, clear = false) {
  const cleared = clear ? nullable.filter((key) => key in values && isBlank(values[key])) : [];
  return {
    ...present(values, codes),
    ...('addToBlacklist' in values ? { addToBlacklist: black } : {}),
    ...(black ? present(values, blacklistFields) : {}),
    ...(black ? Object.fromEntries(cleared.map((key) => [key, null])) : {}),
  };
}
/** POST /exits/employees/:id：任职载荷 + exit 区块；确认令牌只能放在 exit.pendingTransferAck（顶层会 400）。 */
export function createBody(values: Values, mode: 'application' | 'direct', confirm: Values = {}): Values {
  const ack = confirm.pendingTransferAck;
  return {
    mode,
    lastWorkDate: values.lastWorkDate,
    fields: {},
    exit: {
      ...exitOptions(values, values.addToBlacklist === true),
      ...(typeof ack === 'string' ? { pendingTransferAck: ack } : {}),
    },
  };
}
/** PATCH /exits/:id（exitPatchSchema 扁平）：只发人工修改的字段，是否加黑按合并后的值，确认项在顶层。 */
export function patchBody(edited: Values, confirm: Values = {}, merged: Values = edited): Values {
  return {
    ...present(edited, ['lastWorkDate']),
    ...exitOptions(edited, merged.addToBlacklist === true, true),
    ...confirm,
  };
}

/**
 * 回执按真实返回核对（claude_fe_rules a）：新建回 EmploymentBusiness，员工 revision 须大于实际提交的版本；
 * 单据命令（PATCH / 撤销）回本单，id 相同、revision 大于实际提交的版本。
 */
export function acceptExit(raw: unknown, expected: { employeeId?: string; id?: string; sent: number }) {
  const row = raw as Values | null;
  const revision = expected.id ? row?.revision : row?.employeeRevision;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    (expected.id !== undefined && row.id !== expected.id) ||
    (expected.employeeId !== undefined && row.employeeId !== expected.employeeId) ||
    row.kind !== 'leave' ||
    !Number.isSafeInteger(revision) ||
    Number(revision) <= expected.sent
  )
    throw new Error(x.invalidReceipt);
  return { id: row.id, revision: Number(revision) };
}
/** 首次发起交接（详情 / 行内）：回执的离职 revision 不变，outcome 由服务端给。 */
export function acceptHandoverSubmit(raw: unknown, expected: { id: string; sent: number }) {
  const value = raw as Values | null;
  if (value?.exitRequestId !== expected.id || value.revision !== expected.sent || typeof value.outcome !== 'string')
    throw new Error(x.invalidReceipt);
  return { outcome: value.outcome, reason: typeof value.reason === 'string' ? value.reason : undefined };
}
/** 重新提交：回交接单，revision 须前进。 */
export function acceptResubmit(raw: unknown, expected: { id: string; sent: number }) {
  const value = raw as Values | null;
  const revision = Number(value?.revision);
  if (value?.requestId !== expected.id || !Number.isSafeInteger(revision) || revision <= expected.sent)
    throw new Error(x.invalidReceipt);
  return { status: String(value.status) };
}
export type BatchReceipt = { exitRequestId: string; outcome: string; reason?: string };
/** 批量发起：逐人回执须与提交的单一一对应（多、少、重复都按回执无效）。 */
export function parseBatchReceipts(raw: unknown, sent: readonly string[]): BatchReceipt[] {
  const items = (raw as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error(x.invalidReceipt);
  const receipts = items as BatchReceipt[];
  const ids = receipts.map((item) => item?.exitRequestId);
  const valid = receipts.every((item) => typeof item?.outcome === 'string');
  if (!valid || ids.length !== sent.length || new Set(ids).size !== ids.length || !sent.every((id) => ids.includes(id)))
    throw new Error(x.invalidReceipt);
  return sent.map((id) => receipts.find((item) => item.exitRequestId === id)!);
}
