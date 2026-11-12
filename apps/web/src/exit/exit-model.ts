import { codeText } from '../foundation/code-text.js';
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
  type AttachmentPurpose,
} from '@italent/domain';
import { ApiError } from '../foundation/client.js';
import { isBlank, projectFields, sameValue, type Values } from '../foundation/forms/values.js';
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
  /** F-352①：服务端逐单动作（状态 × 按钮权 × 写范围）；状态字段被裁剪时整体缺席。 */
  actions?: string[];
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
  if (key === 'code') return codeText((row[key] as string | null) ?? null);
  if (!(key in row)) return x.missing;
  if (key === 'status') return x.statuses[String(row.status)] ?? text(row.status);
  if (key === 'mode') return x.modes[String(row.mode)] ?? text(row.mode);
  if (key === 'addToBlacklist')
    return typeof row.addToBlacklist === 'boolean' ? x[row.addToBlacklist ? 'yes' : 'no'] : x.missing;
  if (key === 'blacklistReason')
    return (BLACKLIST_REASONS as Record<string, string>)[String(row.blacklistReason)] ?? text(row.blacklistReason);
  // 有效截止日期为空 = 永久（仅加黑单；被裁剪的键走上面的占位）
  if (key === 'blacklistExpiryDate' && row.blacklistExpiryDate === null) return x.permanentValue;
  if (named[key]) return text(row[named[key]] ?? row[key]);
  return text(row[key]);
}

/** F-393：加黑三项逐项按响应键展示，不从可能被裁剪的 addToBlacklist 推导查看权。 */
/** 本人离职的手写申请附件（F-479 用途表，packages/domain/src/attachments/purposes.ts）。 */
export const EXIT_ATTACHMENT: AttachmentPurpose = 'exit.handwritten_application';
export const detailKeys = (row: Row): string[] => [
  ...columns.all,
  'whereaboutsCode',
  'addToBlacklist',
  ...blacklistFields.filter((field) => Object.hasOwn(row, field)),
  // 附件随字段权出现：无权时后端整键缺席，详情不留空行（F-479 设计 §5.3）
  ...(Object.hasOwn(row, 'attachmentRefs') ? ['attachmentRefs'] : []),
];

const validObject = (id: unknown, revision: unknown) =>
  typeof id === 'string' && id !== '' && Number.isSafeInteger(revision) && Number(revision) >= 0;
const HANDOVER_STATUSES = ['in_review', 'approved', 'effective'];

const pick = <T extends keyof typeof EXIT_BUTTONS>(p: ObjectPermission, entries: readonly T[]) =>
  entries.filter((entry) => canButton(p, EXIT_BUTTONS[entry], 'detail'));
/** 工具栏入口：新增操作 + 对应按钮（exit-gate.ts permissionSpec create）。 */
export const createEntries = (p: ObjectPermission | undefined) =>
  p?.dataOperations.create ? pick(p, ['application', 'direct'] as const) : [];

const DETAIL_ACTIONS = ['submit', 'edit', 'cancel'] as const;
/**
 * 详情动作（F-352①）：只认服务端 actions，前端不再按状态与权限快照推导；restore 后端一律拒绝，不提供。
 * actions 是披露而非准入，写入口仍由服务端逐次复核；单据标识无效时不给写入口。
 */
export function detailEntries(row: Row): (typeof DETAIL_ACTIONS)[number][] {
  if (!validObject(row.id, row.revision)) return [];
  return DETAIL_ACTIONS.filter((code) => row.actions?.includes(code));
}

/**
 * 行内动作：发起交接认服务端 rowActions，“离职处理”（B15，办理结果未验证）认服务端 actions 的 handle
 * （已办结且员工在写范围内、有直接离职按钮，由 exit-actions.ts 判定）。
 */
export function rowEntries(row: Row): ('handover' | 'handle')[] {
  const entries: ('handover' | 'handle')[] = [];
  if (validObject(row.id, row.revision) && row.rowActions?.includes(ROW_SUBMIT.code)) entries.push('handover');
  if (typeof row.employeeId === 'string' && row.actions?.includes('handle')) entries.push('handle');
  return entries;
}
/** 批量入口（“离职处理▾”）：列表级按钮有权才显示。 */
export const batchEntryVisible = (p: ObjectPermission | undefined) => canButton(p, BATCH.code, BATCH.level);
/** 批量发起交接：列表级按钮有权，且只对已勾选里带行动作的行（服务端逐条复核）。 */
export const batchHandoverRows = (rows: readonly Row[], p: ObjectPermission | undefined) =>
  batchEntryVisible(p) ? rows.filter((row) => rowEntries(row).includes('handover')) : [];

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

type Activation = { status?: unknown; reason?: unknown; detail?: Values; details?: Values } | null | undefined;
/**
 * 详情的生效失败 / 挂起原因（activation，或命令 409 的 details.activationFailure）：F-240 超上限保留专门文案；
 * 其余 failed 显示原因，suspended 显示挂起；没有 activation 或原因缺席时不推算。
 */
export function activationNotice(source: Row | Values | undefined): string | undefined {
  const failure = (source?.activationFailure ?? source?.activation) as Activation;
  if (typeof failure?.reason !== 'string') return undefined;
  // 详情投影未登记 details.limit（会被裁掉），有就显示，没有只显示原因
  if (failure.reason === TOO_MANY) return x.activationTooMany((failure.detail ?? failure.details)?.limit);
  const reason = x.activationReasons[failure.reason] ?? failure.reason;
  return failure.status === 'suspended' ? x.activationSuspended(reason) : x.activationFailed(reason);
}
/** 列表的通用标记（exit-queries.ts activation：failed / suspended，其余为 null）。 */
export const activationBadge = (row: Row): string | undefined =>
  x.activationBadges[String((row.activation as Activation)?.status)];

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
    else if (warning.reason === 'EXIT_CONTRACTS_TO_HANDLE' && count) messages.push(x.contracts(count));
    else if (warning.reason === 'EXIT_PART_TIMES_TO_END' && count) messages.push(x.partTimes(count));
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
/** 编辑基线只消费详情实际投影，缺键不补造 false / null（F-393）。 */
export const detailValues = (detail: Values): Values =>
  projectFields(
    detail,
    formFields.filter((field) => Object.hasOwn(detail, field)),
  );

function invalid(field: string, message: string): never {
  throw new ApiError(400, 'VALIDATION_FAILED', 'fields', message, {
    details: { fieldErrors: { [field]: [message] } },
  });
}
/**
 * 已加黑且加黑组原样保留：基线取详情真实的加黑三项（F-393；无字段权的键缺席），只改别的字段时
 * 不得要求重填加黑原因，请求体也不带加黑字段（patchBody 只发人工修改的字段）。新增加黑或改动三项任一项时仍按新建口径校验。
 */
export const blackGroupKept = (values: Values, baseline: Values) =>
  baseline.addToBlacklist === true &&
  values.addToBlacklist === true &&
  blacklistFields.every((field) => sameValue(values[field], baseline[field]));

/**
 * 本地校验在命令前抛出（内核：send 里抛错会被判为结果未知）。新建：必填项须可编辑；
 * 编辑（带 baseline）：只校验可编辑项，原有的字典值不能清空（接口不接受 null）。
 */
export function validateExit(values: Values, editable: readonly string[], baseline?: Values) {
  const black = values.addToBlacklist === true && !(baseline && blackGroupKept(values, baseline));
  for (const field of ['lastWorkDate', ...(black ? ['blacklistReason'] : [])]) {
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
    // 总开关缺席不代表未加黑；仍提交有权编辑且实际改动的三项，由服务端复核业务条件。
    ...exitOptions(edited, merged.addToBlacklist !== false, true),
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
/** 申请新建回执（exit-routes.ts 新建，mode = application）：须是草稿，提交审批按离职单自身 id / revision。 */
export function acceptDraft(raw: unknown) {
  const row = raw as Values | null;
  if (row?.status !== 'draft' || !validObject(row.id, row.revision)) throw new Error(x.invalidReceipt);
  return { id: String(row.id), revision: Number(row.revision) };
}
/** POST /exits/:id/submit 请求体（exit-routes.ts transitionBody）：只收顶层 pendingTransferAck，不收 confirmed。 */
export const submitBody = (confirm: Values): Values =>
  typeof confirm.pendingTransferAck === 'string' ? { pendingTransferAck: confirm.pendingTransferAck } : {};

type Target = { detail?: { message?: unknown } | null };
type Downstream = { kind: string; status?: string; action?: string; targets?: Target[]; hiddenCount?: number };
const kindName = (kind: string) => x.downstreamKinds[kind] ?? kind;
function downstreamLine(item: Downstream) {
  const targets = Array.isArray(item.targets) ? item.targets : [];
  const notes = [...new Set(targets.map((target) => target?.detail?.message).filter((m) => typeof m === 'string'))];
  const count = x.downstreamCount(targets.length, Number(item.hiddenCount) || 0);
  return `${kindName(item.kind)}：${count}${notes.length ? `（${notes.join('；')}）` : ''}`;
}
/**
 * 撤销回执 downstream（items + additional）/ 改期回执 downstreamHints（items + probes）与 successor 的展示行
 * （exit-downstream.ts，已按查看人裁剪）：命中项、附加项照服务端给的条数显示；未接入的类目只在已有其他行时附带。
 * 字段缺席时不推算。
 */
export function downstreamLines(raw: unknown): string[] {
  const value = raw as Values | null;
  const list = (value?.downstream ?? value?.downstreamHints) as
    { items?: Downstream[]; additional?: Downstream[]; probes?: Downstream[] } | undefined;
  const items = Array.isArray(list?.items) ? list.items : [];
  const additional = Array.isArray(list?.additional) ? list.additional : [];
  const lines = [
    ...(value?.successor ? [x.successor] : []),
    ...items.filter((item) => item.status === 'found').map(downstreamLine),
    ...additional.map((item) =>
      [downstreamLine(item), x.downstreamActions[String(item.action)]].filter(Boolean).join('，'),
    ),
  ];
  const probes = Array.isArray(list?.probes) ? list.probes : [];
  const missing = [...new Set([...items, ...probes].filter((i) => i.status === 'not_connected').map((i) => i.kind))];
  return lines.length && missing.length ? [...lines, x.notConnected(missing.map(kindName).join('、'))] : lines;
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
