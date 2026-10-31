import {
  RETIREMENT_BUTTONS,
  RETIREMENT_INTENTION_BUTTON,
  RETIREMENT_INTENTION_STATES,
  RETIREMENT_VIEWS,
  type RetirementView,
} from '@italent/domain';
import { isBlank, type Values } from '../foundation/forms/values.js';
import { canButton, fieldAccess, type ObjectPermission } from '../foundation/permission-model.js';
import { m } from './messages.js';

export const object = 'TenantBase.EmploymentRecord';
export const apiRoot = '/api/tenant/employment';
export const retirements = `${apiRoot}/retirements`;
export const intentions = `${apiRoot}/retirement-intentions`;
/**
 * 恢复槽集合（slot.ts）：同一员工的退休办理 / 申请 / 单据提交、撤回、撤销共用员工 id，换入口、换视图都绕不开未知锁；
 * 意向申请是独立表，另用一个集合。
 */
export const retireSlot = `${retirements}/employees`;
export const intentionSlot = `${intentions}/employees`;
export const pageSize = 30;
export const views = RETIREMENT_VIEWS.map((key) => ({ key, label: m.views[key] }));
export type { RetirementView };
export const isPersonView = (view: RetirementView) => view === 'upcoming' || view === 'overdue';

/** GET /retirements 的条目：员工行（即将 / 过期）或退休单行（retirement-views.ts toRetirementItem），按字段权裁剪后缺键。 */
export interface Row {
  id?: string;
  employeeId?: string;
  name?: string;
  departmentId?: string | null;
  status?: string;
  mode?: string;
  revision?: number;
  cancellation?: { id: string; reason?: string } | null;
  [key: string]: unknown;
}
export interface ListResult {
  items: Row[];
  total?: number;
  page: number;
  pageSize: number;
  asOf?: string;
  hasDataPermission?: boolean;
}
export type Filters = { asOf?: string; upcomingDays?: number | null };

// 原站五视图列序 / 列宽未取证（PR“未验证”）：只列后端投影里有的字段。
const base = ['name', 'code', 'departmentId', 'positionId'];
const person = base.concat(
  'expectedRetirementDate daysToRetirement earliestRetirementDate latestRetirementDate'.split(' '),
);
const bill = [...base, 'lastWorkDate', 'effectiveDate', 'retireType', 'mode', 'status'];
export const columns: Record<RetirementView, readonly string[]> = {
  upcoming: person,
  overdue: person,
  processing: bill,
  completed: [...bill, 'reEmployed'],
  all: [...bill, 'reEmployed', 'createdAt'],
};

/** 后端只收 view / asOf / upcomingDays / 分页（retirement-view-routes.ts）；天数只对“即将退休”有意义。 */
export function listPath(view: RetirementView, page: number, filters: Filters = {}): string {
  const query = new URLSearchParams({ view, page: String(page), pageSize: String(pageSize) });
  if (!isBlank(filters.asOf)) query.set('asOf', String(filters.asOf));
  if (view === 'upcoming' && !isBlank(filters.upcomingDays)) query.set('upcomingDays', String(filters.upcomingDays));
  return `${retirements}?${query}`;
}

const text = (input: unknown) =>
  typeof input === 'string' || typeof input === 'number' ? String(input) || m.missing : m.missing;

/** 被裁剪的字段缺键，单元格显示占位，不拿别的字段拼值（claude_fe_rules d）。 */
export function cellValue(row: Row, key: string): string {
  const value = row[key];
  if (key === 'status') return m.states[String(value)] ?? text(value);
  if (key === 'retireType') return m.retireTypes[String(value)] ?? text(value);
  if (key === 'mode') return m.modes[String(value)] ?? text(value);
  if (key === 'reEmployed') return typeof value === 'boolean' ? (value ? m.yes : m.no) : m.missing;
  return text(value);
}

const validObject = (id: unknown, revision: unknown) =>
  typeof id === 'string' && id !== '' && Number.isSafeInteger(revision) && Number(revision) >= 0;
const editable = (p: ObjectPermission, field: string) => !!p.dataOperations.create && fieldAccess(p, field).editable;

export type Entry = 'retire' | 'apply' | 'intention' | 'submit' | 'withdraw' | 'cancel';
/**
 * 入口按视图归属、单据状态与权限快照里的对象操作和按钮显示（读接口没有逐行动作，同 F-268）；资格（在职、无在途离职、
 * 原发起人）由服务端在提交时判定。创建要写最后工作日（exit-gate.ts createPayload 按字段权复核）。
 */
export function entriesFor(view: RetirementView, row: Row, p: ObjectPermission | undefined): Entry[] {
  if (!p || !validObject(row.employeeId, 0)) return [];
  const can = (code: string) => canButton(p, code, 'detail');
  const update = !!p.dataOperations.update;
  if (isPersonView(view)) {
    const create = editable(p, 'lastWorkDate');
    const entries: [Entry, boolean][] = [
      ['retire', create && can(RETIREMENT_BUTTONS.direct)],
      ['apply', create && can(RETIREMENT_BUTTONS.application)],
      ['intention', intentionEntries(undefined, p).includes('create')],
    ];
    return entries.filter(([, shown]) => shown).map(([entry]) => entry);
  }
  if (!validObject(row.id, row.revision) || !update) return [];
  const application = row.mode === 'application' && can(RETIREMENT_BUTTONS.application);
  if (application && (row.status === 'draft' || row.status === 'rejected')) return ['submit'];
  if (application && row.status === 'in_review') return ['withdraw'];
  // 撤销只受理审批通过 / 已生效（retirement-routes.ts，设计 §6B）；已有撤销记录的不再出
  if ((row.status === 'approved' || row.status === 'effective') && !row.cancellation && can(RETIREMENT_BUTTONS.cancel))
    return ['cancel'];
  return [];
}

export type IntentionEntry = 'create' | 'edit' | 'submit' | 'withdraw';
/** 意向申请（retirement-intention-access.ts）：create / update + Employment.RetireIntention；修改另需字段编辑权。 */
export function intentionEntries(
  current: { status?: string } | undefined,
  p: ObjectPermission | undefined,
): IntentionEntry[] {
  if (!p || !canButton(p, RETIREMENT_INTENTION_BUTTON, 'detail')) return [];
  const update = !!p.dataOperations.update;
  const status = current?.status;
  if (status === 'draft' || status === 'rejected')
    return update ? [...(fieldAccess(p, 'intendedDate').editable ? (['edit'] as const) : []), 'submit'] : [];
  if (status === 'in_review') return update ? ['withdraw'] : [];
  return editable(p, 'intendedDate') ? ['create'] : [];
}

/** 职责转交区（B22）：一个接收人 + 下属（直线汇报）+ 部门负责人（员工当前部门），结构同 exit-initiation.ts dutyTransfer。 */
export function dutyTransferOf(values: Values, departmentId: unknown): Values | undefined {
  const receiverId = values.dutyReceiverId;
  if (typeof receiverId !== 'string' || !receiverId) return undefined;
  const ids = Array.isArray(values.dutySubordinateIds) ? (values.dutySubordinateIds as string[]) : [];
  const subordinates = ids.map((employeeId) => ({ employeeId, receiverId, relation: 'direct' }));
  const head = values.transferDepartmentHead === true && typeof departmentId === 'string' && departmentId;
  const orgRoles = head ? [{ orgId: departmentId, role: 'person_in_charge', receiverId }] : [];
  return subordinates.length || orgRoles.length ? { subordinates, orgRoles } : undefined;
}

export type Extra = { ack?: string; confirmed?: boolean };
/** POST /retirements/employees/:id：确认令牌只能放在 exit 里（顶层 pendingTransferAck 被严格体拒绝）；申请不带职责转交。 */
export function retireBody(values: Values, mode: 'direct' | 'application', departmentId: unknown, extra: Extra = {}) {
  const duty = mode === 'direct' ? dutyTransferOf(values, departmentId) : undefined;
  const exit = {
    ...(isBlank(values.handoverEmployeeId) ? {} : { handoverEmployeeId: values.handoverEmployeeId }),
    ...(duty ? { dutyTransfer: duty } : {}),
    ...(extra.ack ? { pendingTransferAck: extra.ack } : {}),
  };
  return { mode, lastWorkDate: values.lastWorkDate, ...(Object.keys(exit).length ? { exit } : {}) };
}

export type Confirmation = { message: string; extra: Extra };
/**
 * 服务端要求二次确认的 409：在途调动 / 考核（EXIT_*_ACK_REQUIRED → 令牌，exit-gate.ts）、撤销超编
 * （CONFIRMATION_REQUIRED → confirmed，exit-cancel-intervals.ts）。其余 409 是确定的拒绝。
 */
export function confirmationOf(error: unknown): Confirmation | undefined {
  const failure = error as { status?: number; message?: string; details?: Values } | null;
  const details = failure?.details;
  if (failure?.status !== 409 || !details) return undefined;
  const message = String(failure.message ?? m.confirmTitle);
  if (details.reason === 'CONFIRMATION_REQUIRED') return { message, extra: { confirmed: true } };
  const ack = ['EXIT_PENDING_TRANSFER_ACK_REQUIRED', 'EXIT_IN_FLIGHT_ASSESSMENT_ACK_REQUIRED'];
  if (ack.includes(String(details.reason)) && typeof details.ackToken === 'string')
    return { message, extra: { ack: details.ackToken } };
  return undefined;
}

export type Notice = { reason: string; count: number | undefined };
/** 预览（exit-preview.ts）：披露形状 {items, hiddenCount}，件数 = 可见 + 不可见；超上限只给 limit、不带件数。 */
export function previewNotices(preview: Values): { blockers: Notice[]; warnings: Notice[] } {
  const notices = (list: unknown) =>
    (Array.isArray(list) ? (list as Values[]) : []).flatMap((item): Notice[] => {
      if (!Array.isArray(item.items)) return 'limit' in item ? [{ reason: String(item.reason), count: undefined }] : [];
      const count = item.items.length + (Number.isSafeInteger(item.hiddenCount) ? Number(item.hiddenCount) : 0);
      return count > 0 ? [{ reason: String(item.reason), count }] : [];
    });
  return { blockers: notices(preview.blockers), warnings: notices(preview.warnings) };
}

/**
 * 回执按真实返回（EmploymentBusiness）核对：同一员工、业务类型为退休；新建把员工 revision 加一，按实际提交的
 * command.revision 判定（claude_fe_rules a）。单据命令（提交 / 撤回 / 撤销）核对单据 id 与 revision。
 */
export function acceptRetirement(value: unknown, expected: { employeeId: string; sent: number; id?: string }): Values {
  const row = value as Values | null | undefined;
  const revision = expected.id ? row?.revision : row?.employeeRevision;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    (expected.id !== undefined && row.id !== expected.id) ||
    row.employeeId !== expected.employeeId ||
    row.kind !== 'retirement' ||
    !Number.isSafeInteger(row.revision) ||
    !Number.isSafeInteger(revision) ||
    Number(revision) <= expected.sent
  )
    throw new Error(m.invalidReceipt);
  return row;
}

/** 意向申请回执（retirement-intention-store.ts intentionView）：新建只核员工与状态；修改 / 提交 / 撤回再核 id 与 revision。 */
export function acceptIntention(value: unknown, expected: { employeeId: string; id?: string; sent?: number }): Values {
  const row = value as Values | null | undefined;
  if (
    !row ||
    typeof row.id !== 'string' ||
    !row.id ||
    row.employeeId !== expected.employeeId ||
    !(RETIREMENT_INTENTION_STATES as readonly unknown[]).includes(row.status) ||
    !Number.isSafeInteger(row.revision) ||
    (expected.id !== undefined && (row.id !== expected.id || Number(row.revision) <= Number(expected.sent)))
  )
    throw new Error(m.invalidReceipt);
  return row;
}

/** 意向申请体：日期必填，原因可空（≤500，服务端校验）；只发有编辑权的字段。 */
export function intentionBody(values: Values, writable: readonly string[]): Values {
  return Object.fromEntries(
    ['intendedDate', 'reason']
      .filter((key) => writable.includes(key))
      .map((key) => [key, isBlank(values[key]) ? null : values[key]]),
  );
}
