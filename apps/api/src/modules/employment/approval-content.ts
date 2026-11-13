/**
 * 任职 / 离退类审批的“内容源”（F-476 P4，设计 §5.4）：三个人事详情入口（任职业务 / 离职 / 退休）共用这一份对象。
 * - 办理时冻结 `loadEmploymentContent` 的结果（办理份 ext）：业务内容 = 详情里除“流程事实”以外的全部键，
 *   含嵌套的业务值（任职记录 record 及其 fields / before、部门、职位、版本列表里的日期）；
 *   流程事实（状态、版本号、动作、生效 / 撤销结果、事件、下游执行结果等）始终读现值，不进办理份。
 * - 已办读取：现值只留流程事实，业务内容全部取自冻结份，再逐字段按披露集合（办理时上限 ∩ 办理节点表单）取舍，
 *   最后仍叠当前字段权；办理份里没有的内容键或不在披露集合里的键一律缺席，不退回现值（DEC-807）。
 * - 字段编码：fields.X / 扩展字段 X 就是 X；自定义字段按 `custom:<id>` 判，响应键仍是裸 id；
 *   离职的 positionId 对应审批表单的 postId；不属于审批表单的键（试用期、加黑原因等）没有编码，已办读取不披露。
 */
import { withTenant, type Tx } from '@italent/db';
import { sql } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { captureAttachments, type AttachmentSummary } from '../attachments/carrier-read.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { approvalError } from '../approval/context.js';
import { disclosedFields, readDetail, type DetailData } from '../approval/disclosure.js';
import { foreignVisibility, viewableWithForeign } from '../approval/foreign-fields.js';
import { contentViewOf, type ContentSelection } from '../approval/handling-content.js';
import { latestInstanceOf } from '../approval/store.js';
import { authorizeInTransaction, getModuleViewableFieldsInTransaction } from '../permission/module-access.js';
import { loadExitDetail, type ExitViewable } from './exit-queries.js';
import { loadEmploymentBusiness, rowsOf } from './read-model.js';
import { loadRetirementDetail } from './retirement-views.js';

type Row = Record<string, unknown>;

/** 任职业务详情里的流程事实（读现值）；其余键都是业务内容（含 record：生效后的记录是业务值，不能由现值旁路补露）。 */
const BUSINESS_FACTS: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'revision',
  'employeeRevision',
  'status',
  'kind',
  'mode',
  'formId',
  'employeeStatus',
  'entryStatus',
  'activation',
]);

/**
 * 离职 / 退休详情里的流程事实（读现值）：身份、状态、动作、生效 / 撤销结果、事件、下游执行结果。
 * 部门、职位、版本列表（里面有最后工作日 / 生效日）是业务内容，取冻结份；dutyTransfer 的件数读现值、timing 取冻结份。
 */
const EXIT_FACTS: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'code',
  'name',
  'status',
  'actions',
  'mode',
  'initiator',
  'initiatorUserId',
  'batchId',
  'revision',
  'createdAt',
  'activation',
  'cancellation',
  'events',
  'approvalInstanceId',
  'effects',
  'dutyTransfer',
]);

/** 响应路径依赖的字段里属于流程事实的那些：只按当前字段权判，不要求在办理披露集合里。 */
const FACT_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'status',
  'mode',
  'initiator',
  'initiatorUserId',
  'batchId',
  'revision',
  'createdAt',
  'activation',
  'kind',
  'versionNo',
]);

/** 审批表单里与响应键不同名的字段编码。 */
const approvalCodeOf = (field: string): string => (field === 'positionId' ? 'postId' : field);

/** 记录里不含业务值的结构键（标识、版本、状态标记、链接）；其余记录键按编码判披露。 */
const RECORD_STRUCTURE: ReadonlySet<string> = new Set([
  'id',
  'employeeId',
  'tenantId',
  'revision',
  'kind',
  'changeType',
  'status',
  'isCurrent',
  'isLatest',
  'isInserted',
  'previousRecordId',
]);

export interface EmploymentContent {
  readonly business: Row;
  /** 离职单 / 退休单的专用详情内容；其他类型为 null。 */
  readonly exit: Row | null;
}

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

const contentOf = (source: Row, facts: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !facts.has(key)));

const EXIT_KINDS: ReadonlySet<string> = new Set(['leave', 'retirement']);

/** 读全任职业务的内容现值（办理时冻结的 ext）；业务不存在返回 null。 */
export async function loadEmploymentContent(
  tx: Tx,
  tenantId: string,
  businessId: string,
): Promise<EmploymentContent | null> {
  // 业务内容不随查询日期变化；asOf 只影响生效后的“当前记录”，那属于流程事实、不进办理份
  const business = await loadEmploymentBusiness(tx, tenantId, businessId, new Date().toISOString().slice(0, 10));
  if (!business) return null;
  const exit =
    business.kind === 'leave'
      ? await loadExitDetail(tx, tenantId, businessId, undefined)
      : business.kind === 'retirement'
        ? await loadRetirementDetail(tx, tenantId, businessId, undefined)
        : null;
  return {
    business: contentOf(business as unknown as Row, BUSINESS_FACTS),
    exit: exit ? withCapturedAttachments(contentOf(exit as unknown as Row, EXIT_FACTS)) : null,
  };
}

/**
 * F-479 §2.3 附件字段的捕获契约：办理份里 attachmentRefs 是有序 ID 列表（已在内容里），attachments 只存展示元数据
 * [{id, filename, contentType, byteSize}]；不存字节、下载地址与上传时间。退休单没有附件键，原样返回。
 */
function withCapturedAttachments(exit: Row): Row {
  const listed = exit.attachments;
  if (!Array.isArray(listed)) return exit;
  return { ...exit, attachments: captureAttachments(listed as AttachmentSummary[]) };
}

/** 办理份里的业务日期：YYYY-MM-DD 且是真实存在的日子（投影会做日期运算，非法值会在投影里抛错）。 */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** 业务部分投影会读的键：composeBusiness 的字段对象、自定义字段、生效后的记录（未生效为 null）、生效日。 */
function hasBusinessContent(business: unknown): boolean {
  return (
    isRow(business) &&
    isRow(business.fields) &&
    isRow(business.customFields) &&
    (business.record === null || isRow(business.record)) &&
    isIsoDate(business.effectiveDate)
  );
}

/** 离退部分投影会读的键：exitDetailPayload 的原定 / 最终日期块（含 +1 天运算）与版本列表。 */
function hasExitContent(exit: unknown): boolean {
  return (
    isRow(exit) &&
    Array.isArray(exit.versions) &&
    exit.versions.every(isRow) &&
    isIsoDate(exit.plannedLastWorkDate) &&
    isIsoDate(exit.lastWorkDate) &&
    isIsoDate(exit.effectiveDate)
  );
}

/**
 * 按可信的业务类型（现值里的 kind，不取自办理份）核对办理份里投影实际会读的必需键；缺失、null 或非法一律视为
 * 办理份不可读（503），不让投影在日期运算里抛 500。这是新写办理份的结构自检，不是旧数据兼容（DEC-402）。
 */
function hasRequiredContent(ext: unknown, kind: string): ext is EmploymentContent {
  if (!isRow(ext) || !hasBusinessContent(ext.business)) return false;
  return !EXIT_KINDS.has(kind) || hasExitContent(ext.exit);
}

const pickCodes = (source: unknown, allowed: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries(isRow(source) ? source : {}).filter(([code]) => allowed.has(approvalCodeOf(code))));

/** 自定义字段：按 `custom:<id>` 判披露，响应键仍是裸 id。 */
const pickCustom = (source: unknown, allowed: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries(isRow(source) ? source : {}).filter(([id]) => allowed.has(`custom:${id}`)));

const pickFacts = (live: object, facts: ReadonlySet<string>): Row =>
  Object.fromEntries(Object.entries(live).filter(([key]) => facts.has(key)));

function pickRecord(record: unknown, allowed: ReadonlySet<string>): Row | null {
  if (!isRow(record)) return null;
  const result: Row = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'fields') result.fields = pickCodes(value, allowed);
    else if (key === 'customFields') result.customFields = pickCustom(value, allowed);
    else if (key === 'before')
      result.before = isRow(value)
        ? { fields: pickCodes(value.fields, allowed), customFields: pickCustom(value.customFields, allowed) }
        : null;
    else if (RECORD_STRUCTURE.has(key) || allowed.has(approvalCodeOf(key))) result[key] = value;
  }
  return result;
}

/** 已办读取（任职业务）：现值只留流程事实，业务内容（含 record）全部取自冻结份且逐字段按披露集合取舍。 */
export function composeBusiness(live: object, content: EmploymentContent, allowed: ReadonlySet<string>): Row {
  const frozen = content.business;
  const result = pickFacts(live, BUSINESS_FACTS);
  result.fields = pickCodes(frozen.fields, allowed);
  result.customFields = pickCustom(frozen.customFields, allowed);
  result.record = pickRecord(frozen.record, allowed);
  if (allowed.has('effectiveDate') && Object.hasOwn(frozen, 'effectiveDate'))
    result.effectiveDate = frozen.effectiveDate;
  return result;
}

/**
 * 已办读取（离职 / 退休）：现值只留流程事实，业务内容全取自冻结份。逐路径的披露取舍由 `disclosing` 在裁剪时完成，
 * 所以原定 / 最终日期块、版本列表、名称类派生键都跟随各自字段，不再有单独的映射。
 */
export function composeExit(live: object, content: EmploymentContent): Row {
  const frozen = content.exit as Row;
  const duty = (live as Row).dutyTransfer as Row | undefined;
  return {
    ...pickFacts(live, EXIT_FACTS),
    ...frozen,
    dutyTransfer: { ...duty, timing: frozen.dutyTransferTiming },
  };
}

/**
 * 已办读离职详情时附件只留“现在仍是 bound 的”：HR 载体下载只认 bound（设计 §3.3），办理份里后来被删去 / 清理的文件
 * 整项缺席，不回显办理时的旧文件名。`live` 是同一请求取的现值详情（只含 bound 摘要）。
 */
export function keepLiveAttachments(frozen: Row, live: { readonly attachments?: readonly { id: string }[] }): Row {
  if (!Array.isArray(frozen.attachments)) return frozen;
  const current = new Set((live.attachments ?? []).map((item) => item.id.toLowerCase()));
  const kept = (frozen.attachments as readonly { id: string }[]).filter((item) => current.has(item.id.toLowerCase()));
  return { ...frozen, attachments: kept };
}

/**
 * 已办读取的字段可见性：当前字段权 ∩ （流程事实字段，或在办理披露集合里的字段）。
 * 不在表里的业务字段一律缺席（fail-closed）。
 */
export function disclosing(show: ExitViewable, allowed: ReadonlySet<string>): ExitViewable {
  const discloses = disclosedBy(allowed);
  return { employee: show.employee, employment: (field) => show.employment(field) && discloses(field) };
}

/** 办理披露集合对单个响应字段的判定（流程事实字段始终放行）；失败详情等嵌套内容的投影共用这一处。 */
export function disclosedBy(allowed: ReadonlySet<string>): (field: string) => boolean {
  return (field) => FACT_FIELDS.has(field) || allowed.has(approvalCodeOf(field));
}

/**
 * 以参与人身份打开最新审批实例，只为决定内容来源：不带管理员范围——纯管理员没有办理记录，本来就读现值，
 * 不必为此再判审批中心的管理按钮；打不开（不是参与人）返回 null。
 */
async function openAsParticipant(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  instanceId: string,
): Promise<DetailData | null> {
  const viewer = { userId: ctx.userId, transferScope: null, interveneScope: null };
  try {
    return await readDetail(tx, { ...ctx, now, commandId: '', expectedRevision: 0 }, instanceId, viewer, false);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export interface EmploymentRead {
  readonly contentView: ReturnType<typeof contentViewOf> | { mode: 'live'; instanceId: null };
  /** 已办读取：冻结内容与披露集合；现值读取为 null。 */
  readonly frozen: { readonly content: EmploymentContent; readonly allowed: ReadonlySet<string> } | null;
}

const LIVE_READ: EmploymentRead = { contentView: { mode: 'live', instanceId: null }, frozen: null };

async function liveKindOf(tx: Tx, tenantId: string, businessId: string): Promise<string | null> {
  const [row] = rowsOf<{ kind: string }>(
    await tx.execute(sql`
      SELECT kind FROM employment_payload_versions
      WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY version_no DESC LIMIT 1
    `),
  );
  return row?.kind ?? null;
}

/**
 * 选内容来源：本人有待办 / 是发起人 / 没办理过 → 现值；本人最近一次办理 → 冻结份（缺份、缺结构 503）。
 * 调用方在自己的入口里决定数据范围：已办读取（返回 frozen）是本人办理时那份，不套用当前数据范围（DEC-834④），
 * 其余读取沿用原入口的范围规则；成员、对象权限与当前字段权两种读取都照旧校验。
 * `kinds` 是该入口接受的业务类型（离职入口只认 leave 等）；类型不符按现值读，由入口原有的取数返回 404。
 */
export async function selectEmploymentRead(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  businessId: string,
  kinds?: readonly string[],
): Promise<EmploymentRead> {
  return withTenant(deps.db, ctx.tenantId, async (tx) => {
    const kind = await liveKindOf(tx, ctx.tenantId, businessId);
    if (!kind || (kinds && !kinds.includes(kind))) return LIVE_READ;
    const instance = await latestInstanceOf(tx, ctx.tenantId, 'employment', businessId);
    if (!instance) return LIVE_READ;
    const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
    const data = await openAsParticipant(tx, ctx, deps.clock(), instance.id);
    const selection: ContentSelection = data?.content ?? { mode: 'live' };
    const contentView = contentViewOf(instance.id, selection);
    if (!data || selection.mode === 'live') return { contentView, frozen: null };
    const content = selection.frozen.content.ext;
    // 缺办理份内容（含改造前写下的、新写但局部缺损的）一律失败闭合，不拿现值顶替（DEC-807；不做旧数据兼容，DEC-402）
    if (!hasRequiredContent(content, kind)) {
      throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');
    }
    const own = await getModuleViewableFieldsInTransaction(bound, ctx, data.snapshot.fieldObjectCode, tx);
    const viewable = await viewableWithForeign(data.snapshot, own, foreignVisibility(bound, ctx, tx));
    return { contentView, frozen: { content, allowed: disclosedFields(data, ctx.userId, viewable) } };
  });
}
