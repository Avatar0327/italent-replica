/**
 * 审批详情与最小披露（DEC-057，REQ-APV-003 R3/R4）：只显示查看人所在节点的表单字段，并按其字段权限裁剪；
 * 变更前原值受租户开关「审批详情页显示原信息」控制；审批不产生任何数据范围（`11` §16）。
 * 盲审（DEC-058 / DEC-119）：本单变化字段中有查看人不可见的字段即为盲审。
 * 授权、披露与动作一律按完整任务计算（F1），最新 200 条只是展示窗口。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  blindReviewFields,
  disclosedFieldNames,
  hasExit,
  isCountersign,
  recordsHiddenFor,
  rejectAllowed,
  visibleWhenHidden,
  type ApprovalNode,
  type EditMode,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { ADAPTERS, type BusinessSnapshot } from './adapters.js';
import { formFieldsWithForeign } from './foreign-fields.js';
import { rowsOf, type ApprovalContext, type Row } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import { userOfPerson } from './resolver.js';
import { addSignAllowed, addSignLink, isOwnRequest, retrievableTask, urgeOpen, votesInTransition } from './rules.js';
import { displayWindow, loadInstance, loadLogs, loadTasks, type InstanceRow, type TaskRow } from './store.js';

export const SHOW_ORIGINALS_SETTING = 'approval.show_original_values';

export interface Viewer {
  readonly userId: string;
  /**
   * 管理员转交、干预两个按钮各自的实例范围（按钮 + 数据范围的 SQL 判定，没有该按钮为 null）。详情按钮逐个公布
   * （第四轮 N8）；任一覆盖即可打开详情。
   */
  readonly transferScope: SQL | null;
  readonly interveneScope: SQL | null;
}

export interface DetailData {
  readonly instance: InstanceRow;
  readonly version: VersionView;
  readonly snapshot: BusinessSnapshot;
  /** 展示窗口：最新 200 条与全部在办 / 排队任务。 */
  readonly tasks: readonly TaskRow[];
  /** 完整任务：查看人所在节点、记录隐藏与可用动作都按它判断，不受展示窗口影响（F1）。 */
  readonly allTasks: readonly TaskRow[];
  readonly logs: Awaited<ReturnType<typeof loadLogs>>;
  readonly showOriginals: boolean;
  /** 查看人可对本单执行的管理员动作（N8）。 */
  readonly admin: { readonly transfer: boolean; readonly intervene: boolean };
  readonly subjectUserId: string | null;
  /** 查看人被抄送的节点（DEC-097）：被抄送人只看该节点的表单。 */
  readonly ccNodeKey: string | null;
}

async function adminCovers(tx: Tx, tenantId: string, instanceId: string, scope: SQL | null): Promise<boolean> {
  if (!scope) return false;
  const [row] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM approval_instances i
      WHERE i.tenant_id=${tenantId} AND i.id=${instanceId}::uuid AND ${scope}`),
  );
  return Boolean(row);
}

/** 参与人（发起人、任一任务的审批人）或范围内的流程管理员才能打开详情；其余一律按不存在处理。 */
export async function readDetail(
  tx: Tx,
  ctx: ApprovalContext,
  instanceId: string,
  viewer: Viewer,
): Promise<DetailData> {
  const instance = await loadInstance(tx, ctx.tenantId, instanceId);
  await assertCanOpen(tx, ctx, instance, viewer);
  const allTasks = await loadTasks(tx, ctx.tenantId, instanceId);
  const ccNodeKey = await ccNodeOf(tx, ctx.tenantId, instanceId, viewer.userId);
  const admin = {
    transfer: await adminCovers(tx, ctx.tenantId, instanceId, viewer.transferScope),
    intervene: await adminCovers(tx, ctx.tenantId, instanceId, viewer.interveneScope),
  };
  const setting = await readEffectiveSetting(tx, ctx.tenantId, SHOW_ORIGINALS_SETTING);
  return {
    instance,
    version: await loadVersion(tx, ctx.tenantId, instance.versionId),
    snapshot: await ADAPTERS[instance.businessType].snapshot(tx, ctx, instance.businessId),
    tasks: displayWindow(allTasks),
    allTasks,
    logs: await loadLogs(tx, ctx.tenantId, instanceId),
    showOriginals: setting.value === true,
    admin,
    subjectUserId: await userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId),
    ccNodeKey,
  };
}

/**
 * 参与人（发起人、任一任务的审批人、被抄送人）或范围内的流程管理员才能打开详情 / 历史；其余一律按不存在处理。
 * C-非3：被自审跳过的人只是留痕，不因此成为参与人。
 */
export async function assertCanOpen(tx: Tx, ctx: ApprovalContext, instance: InstanceRow, viewer: Viewer) {
  if (instance.initiatorUserId === viewer.userId) return;
  const [participant] = rowsOf(
    await tx.execute(sql`SELECT 1 WHERE EXISTS (SELECT 1 FROM approval_tasks t WHERE t.tenant_id=${ctx.tenantId}
        AND t.instance_id=${instance.id}::uuid AND t.assignee_user_id=${viewer.userId}::uuid AND t.origin<>'self_skip')
      OR EXISTS (SELECT 1 FROM approval_instance_ccs c WHERE c.tenant_id=${ctx.tenantId}
        AND c.instance_id=${instance.id}::uuid AND c.user_id=${viewer.userId}::uuid)`),
  );
  if (participant) return;
  for (const scope of [viewer.transferScope, viewer.interveneScope]) {
    if (await adminCovers(tx, ctx.tenantId, instance.id, scope)) return;
  }
  throw new AppError('NOT_FOUND', '审批实例不存在');
}

async function ccNodeOf(tx: Tx, tenantId: string, instanceId: string, userId: string): Promise<string | null> {
  const [row] = rowsOf<{ node_key: string }>(
    await tx.execute(sql`SELECT node_key FROM approval_instance_ccs
      WHERE tenant_id=${tenantId} AND instance_id=${instanceId}::uuid AND user_id=${userId}::uuid
      ORDER BY created_at DESC LIMIT 1`),
  );
  return row?.node_key ?? null;
}

/** 查看人作为审批人参与过的任务（被自审跳过只是留痕，不算参与，C-非3）。 */
function ownTasks(data: Pick<DetailData, 'allTasks'>, userId: string): TaskRow[] {
  return data.allTasks.filter((task) => task.assigneeUserId === userId && task.origin !== 'self_skip');
}

/** 查看人所在节点：最近一次参与的节点 → 被抄送的节点 → 当前节点。 */
export function viewerNode(data: DetailData, userId: string): ApprovalNode | null {
  const key =
    ownTasks(data, userId).at(-1)?.nodeKey ??
    data.ccNodeKey ??
    data.instance.currentNodeKey ??
    data.allTasks.at(-1)?.nodeKey ??
    data.version.nodes[0]?.key;
  return data.version.nodes.find((node) => node.key === key) ?? null;
}

/** DEC-119：本查看人可见的字段名（节点表单 ∩ 字段查看权），表单值、原值与日志字段名共用。 */
export function disclosedFields(data: DetailData, userId: string, viewable: ReadonlySet<string> | undefined) {
  return disclosedFieldNames(
    formFieldsWithForeign(viewerNode(data, userId)?.formFields ?? [], data.snapshot),
    viewable,
  );
}

function pick(source: Readonly<Row>, fields: readonly string[]): Row {
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]),
  );
}

/** 详情公布的动作与命令执行共用同一套判定（rules.ts），不公布执行不了的动作（X-15 / X-16 / F14 / F16）。 */
function actionsFor(data: DetailData, userId: string, blind: boolean): string[] {
  const { instance, version, allTasks } = data;
  const actions: string[] = [];
  const running = instance.status === 'running';
  const mine = allTasks.find((task) => task.status === 'pending' && task.assigneeUserId === userId);
  const node = version.nodes.find((candidate) => candidate.key === (mine?.nodeKey ?? instance.currentNodeKey));
  const own = isOwnRequest(instance, data.subjectUserId, userId);
  // DEC-058：发起人或异动本人不能审批；看不到本单变化字段的人（盲审，C-非4）也不显示同意 / 驳回，只能转交。
  const decide = !own && !blind;
  if (running && mine && node) {
    // DEC-144：同意 / 不同意是出口动作，按节点配置公布；会签节点的前加签人不计入流转规则，不公布不同意（DEC-152）。
    // 驳回是节点开关（F-003 第二轮），加签人沿用原节点开关。
    const votes = !isCountersign(node) || votesInTransition(allTasks, mine);
    if (decide && hasExit(node, 'approve')) actions.push('approve');
    if (decide && votes && hasExit(node, 'disagree')) actions.push('disagree');
    if (decide && rejectAllowed(node)) actions.push('reject');
    if (node.actions.transfer || mine.isExceptionAdmin) actions.push('transfer');
    if (decide && node.actions.addSign && addSignAllowed(allTasks, mine)) actions.push('addSign');
    // `14` §11.3：加签人不能编辑表单内容，只有本节点原审批人可以；DEC-105：员工信息类不开放编辑。
    const editable = APPROVAL_TYPES[data.snapshot.approvalType].approvalEdit && !addSignLink(allTasks, mine);
    if (decide && node.editMode === 'separate' && editable) actions.push('edit');
    if (node.actions.copySend) actions.push('cc');
  }
  if (retrievableTask(instance, version, allTasks, userId)) actions.push('retrieve');
  if (instance.initiatorUserId === userId) actions.push(...initiatorActions(data));
  // DEC-092：本人发起或本人为异动对象的申请，不公布管理员转交 / 干预。
  if (running && !own && data.admin.transfer) actions.push('adminTransfer');
  if (running && !own && data.admin.intervene) actions.push('adminIntervene');
  return actions;
}

function initiatorActions({ instance, version }: DetailData): string[] {
  const actions: string[] = [];
  if (['running', 'returned'].includes(instance.status)) actions.push('withdraw');
  // X-16：任职申请只能在申请单上修改后提交，审批侧不公布执行不了的“重提”；员工子集变更撤回后也可沿原实例重提（F9）。
  const personnel = instance.businessType === 'personnel_change';
  if (personnel && ['returned', 'withdrawn'].includes(instance.status)) actions.push('resubmit');
  if (urgeOpen(instance, version)) actions.push('urge');
  return actions;
}

export function detailView(
  data: DetailData,
  userId: string,
  viewable: ReadonlySet<string> | undefined,
  editing: { readonly editMode: EditMode; readonly editableFields: readonly string[] } = {
    editMode: 'none',
    editableFields: [],
  },
) {
  const { instance, version, snapshot } = data;
  const node = viewerNode(data, userId);
  const hidden = recordsHidden(data, userId);
  const disclosed = disclosedFields(data, userId, viewable);
  const fields = [...disclosed];
  // DEC-195：两项日期沿用生效日期的节点表单与字段查看权限，不扩展审批快照。
  if (instance.status === 'approved' && disclosed.has('effectiveDate'))
    fields.push('originalEffectiveDate', 'actualEffectiveDate');
  const names = new Map(version.nodes.map((candidate) => [candidate.key, candidate.name]));
  const originals = data.showOriginals && snapshot.originals ? { originals: pick(snapshot.originals, fields) } : {};
  return {
    id: instance.id,
    status: instance.status,
    approvalType: instance.approvalType,
    processId: instance.processId,
    processCode: instance.processCode,
    versionNo: version.versionNo,
    title: instance.title,
    businessId: instance.businessId,
    revision: instance.revision,
    currentNodeKey: instance.currentNodeKey,
    round: instance.round,
    initiatorUserId: instance.initiatorUserId,
    subjectEmployeeId: instance.subjectEmployeeId,
    createdAt: instance.createdAt,
    completedAt: instance.completedAt,
    taskId:
      instance.status === 'running'
        ? (data.allTasks.find((task) => task.status === 'pending' && task.assigneeUserId === userId)?.id ?? null)
        : null,
    retrieveTaskId: retrievableTask(instance, version, data.allTasks, userId)?.id ?? null,
    tasks: visibleTasks(data, userId, data.tasks).map((task) => ({
      ...task,
      nodeName: names.get(task.nodeKey) ?? task.nodeKey,
    })),
    logs: hidden ? [] : data.logs.map((log) => projectLog(log, disclosed)),
    recordsHidden: hidden,
    commentNotice: COMMENT_NOTICE,
    form: { nodeKey: node?.key ?? null, values: pick(snapshot.values, fields), ...originals, ...editing },
    actions: [...new Set(actionsFor(data, userId, blindReviewFields(snapshot.changedFields, viewable).length > 0))],
  };
}

/** DEC-100：意见框旁的提示（意见默认对所有能打开详情页的人公开）。 */
export const COMMENT_NOTICE = '审批意见默认对所有能查看本单的人公开，请勿在意见中填写敏感信息';

/**
 * DEC-104「审批记录查看权限」是查看方的设置（`14` §11.9）：按 DEC-115 严格隐藏——查看人参与过的任一节点勾选了
 * 开关，或查看人是发起人且开始节点勾选了开关，即隐藏审批记录与沟通。不是审批人的人（被抄送人、范围内管理员）
 * 不受限制。
 */
type RecordScope = Pick<DetailData, 'instance' | 'version' | 'allTasks'>;
export function recordsHidden(data: RecordScope, userId: string): boolean {
  const participated = new Set(ownTasks(data, userId).map((task) => task.nodeKey));
  return recordsHiddenFor({
    participatedNodeHides: data.version.nodes.filter((node) => participated.has(node.key)).map((n) => n.hideRecords),
    isInitiator: data.instance.initiatorUserId === userId,
    hideFromInitiator: data.version.hideRecordsFromInitiator,
  });
}

/** 记录被隐藏时，已处理的任务（含本人的，连同意见）一律不返回，只保留当前待办（DEC-115）。 */
export function visibleTasks<T extends TaskRow>(data: RecordScope, userId: string, tasks: readonly T[]): T[] {
  if (!recordsHidden(data, userId)) return [...tasks];
  return tasks.filter(visibleWhenHidden);
}

/** X-13 / DEC-119：日志里的字段名（盲审、编辑）只留查看人可见的字段；完整信息只留在内部审计。 */
export function projectLog<T extends { detail: Row }>(log: T, disclosed: ReadonlySet<string>): T {
  if (!Array.isArray(log.detail.fields)) return log;
  return {
    ...log,
    detail: { ...log.detail, fields: log.detail.fields.filter((field) => disclosed.has(String(field))) },
  };
}

export type InstanceView = ReturnType<typeof detailView>;
