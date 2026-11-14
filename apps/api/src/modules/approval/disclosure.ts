/**
 * 审批详情与最小披露（DEC-057，REQ-APV-003 R3/R4）：只显示查看人所在节点的表单字段，并按其字段权限裁剪；
 * 变更前原值受租户开关「审批详情页显示原信息」控制；审批不产生任何数据范围（`11` §16）。
 * 盲审（DEC-058 / DEC-119）：本单变化字段中有查看人不可见的字段即为盲审。
 * 授权、披露与动作一律按完整任务计算（F1），最新 200 条只是展示窗口。
 */
import { sql, type Tx } from '@italent/db';
import { attachmentSummaries } from '../attachments/carrier-read.js';
import {
  instanceRecusal,
  jumpAllowed,
  nodeRecusal,
  rejectToPreviousAllowed,
  blindReviewFields,
  disclosedFieldNames,
  hasApproveExit,
  hasExit,
  isCountersign,
  recordsHiddenFor,
  rejectAllowed,
  visibleWhenHidden,
  type ApprovalNode,
  type RecusalFacts,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { employmentTypeNames } from '../employment/employment-types.js';
import type { TenantContext } from '../../tenant-context.js';
import { projectBatchValues, projectOfferValues } from '../offer/frozen-view.js';
import { referenceNames } from './reference-names.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { ADAPTERS, type BusinessSnapshot } from './adapters.js';
import { exitsView, NO_PATH_FACTS, pathView, type PathFacts } from './detail-path.js';
import { editSurface, type EditSurface } from './edit-surface.js';
import { formFieldsWithForeign } from './foreign-fields.js';
import { rowsOf, type ApprovalContext, type Row } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import { capViewable, contentViewOf, selectContent, type ContentSelection } from './handling-content.js';
import { addSignAllowed, addSignLink, retrievableTask, urgeOpen, votesInTransition } from './rules.js';
import { approvalWithdrawalFailure } from './withdraw-eligibility.js';
import { loadRecusalFacts } from './subjects.js';
import { displayWindow, loadInstance, loadLogs, loadTasks, type InstanceRow, type TaskRow } from './store.js';

export const SHOW_ORIGINALS_SETTING = 'approval.show_original_values';

/** 「审批原值显示」开关（租户设置，缺省显示）：申请详情与审批中心共用。 */
export async function showOriginalsOf(tx: Tx, tenantId: string): Promise<boolean> {
  return (await readEffectiveSetting(tx, tenantId, SHOW_ORIGINALS_SETTING)).value === true;
}

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
  /** 展示用快照：已办读冻结份里的快照，其余读现值。 */
  readonly snapshot: BusinessSnapshot;
  /** 当前流程事实的条件值（始终取现值）：路径推演用它，不随冻结份回退（F-476 §0.2）。 */
  readonly conditionValues: BusinessSnapshot['conditionValues'];
  /** 展示窗口：最新 200 条与全部在办 / 排队任务。 */
  readonly tasks: readonly TaskRow[];
  /** 完整任务：查看人所在节点、记录隐藏与可用动作都按它判断，不受展示窗口影响（F1）。 */
  readonly allTasks: readonly TaskRow[];
  readonly logs: Awaited<ReturnType<typeof loadLogs>>;
  readonly showOriginals: boolean;
  /** 查看人可对本单执行的管理员动作（N8）。 */
  readonly admin: { readonly transfer: boolean; readonly intervene: boolean };
  /** 实例冻结的回避事实（F-048）：动作按它判定，不对外披露（DEC-057）。 */
  readonly recusal: RecusalFacts;
  /** 查看人被抄送的节点（DEC-097）：被抄送人只看该节点的表单。 */
  readonly ccNodeKey: string | null;
  /** 内容来源（F-476）：在办 / 发起人读现值；已办读办理时冻结份，snapshot 即为冻结份里的快照。 */
  readonly content: ContentSelection;
}

async function adminCovers(tx: Tx, tenantId: string, instanceId: string, scope: SQL | null): Promise<boolean> {
  if (!scope) return false;
  const [row] = rowsOf(
    await tx.execute(sql`SELECT 1 FROM approval_instances i
      WHERE i.tenant_id=${tenantId} AND i.id=${instanceId}::uuid AND ${scope}`),
  );
  return Boolean(row);
}

/**
 * 参与人（发起人、任一任务的审批人）或范围内的流程管理员才能打开详情；其余一律按不存在处理。
 * withLogs=false：历史分页另取完整日志（只补一次操作人姓名，F-264），这里不读近期日志，`logs` 为空。
 */
export async function readDetail(
  tx: Tx,
  ctx: ApprovalContext,
  instanceId: string,
  viewer: Viewer,
  withLogs = true,
): Promise<DetailData> {
  const instance = await loadInstance(tx, ctx.tenantId, instanceId);
  await assertCanOpen(tx, ctx, instance, viewer);
  const allTasks = await loadTasks(tx, ctx.tenantId, instanceId);
  const ccNodeKey = await ccNodeOf(tx, ctx.tenantId, instanceId, viewer.userId);
  const admin = {
    transfer: await adminCovers(tx, ctx.tenantId, instanceId, viewer.transferScope),
    intervene: await adminCovers(tx, ctx.tenantId, instanceId, viewer.interveneScope),
  };
  // F-476：先选内容来源（缺份 503，DEC-807），已办读冻结份里的快照，其余读现值
  const content: ContentSelection = await selectContent(tx, ctx, instance, allTasks, viewer.userId);
  // 当前流程事实始终读现值；冻结份只供展示（设计 §0.2），不得进入路径推演
  const live = await ADAPTERS[instance.businessType].snapshot(tx, ctx, instance.businessId);
  return {
    instance,
    version: await loadVersion(tx, ctx.tenantId, instance.versionId),
    snapshot: content.mode === 'frozen' ? content.frozen.content.snapshot : live,
    conditionValues: live.conditionValues,
    content,
    tasks: displayWindow(allTasks),
    allTasks,
    logs: withLogs ? await loadLogs(tx, ctx.tenantId, instanceId) : [],
    showOriginals: await showOriginalsOf(tx, ctx.tenantId),
    admin,
    recusal: await loadRecusalFacts(tx, ctx.tenantId, instance),
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
        AND t.instance_id=${instance.id}::uuid AND t.assignee_user_id=${viewer.userId}::uuid
        AND t.origin NOT IN ('self_skip','subject_skip'))
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
type RecordTask = Pick<TaskRow, 'assigneeUserId' | 'origin' | 'nodeKey'>;
function ownTasks<T extends RecordTask>(data: { readonly allTasks: readonly T[] }, userId: string): T[] {
  return data.allTasks.filter(
    (task) => task.assigneeUserId === userId && task.origin !== 'self_skip' && task.origin !== 'subject_skip',
  );
}

/** 查看人所在节点：最近一次参与的节点 → 被抄送的节点 → 当前节点。 */
export function viewerNode(data: DetailData, userId: string): ApprovalNode | null {
  // 已办读办理份：节点与表单按办理时的流程版本、办理的那个节点，不随之后的任务 / 版本变化（F-476 §5.3）
  if (data.content.mode === 'frozen') {
    const { frozen } = data.content;
    return frozen.version.nodes.find((node) => node.key === frozen.nodeKey) ?? null;
  }
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
  // 三者取交：办理时的披露上限 ∩ 办理节点表单 ∩ 当前字段权限（F-476 §5.3，DEC-807）
  const ceiling = data.content.mode === 'frozen' ? data.content.frozen.ceiling : null;
  // 员工档案只读字段的办理时上限已并入 viewable（routes.ownViewable，F-511），不再被本单对象的上限二次剔除
  const profile = viewable ? data.snapshot.profileFields.filter((field) => viewable.has(field)) : [];
  return disclosedFieldNames(
    formFieldsWithForeign(viewerNode(data, userId)?.formFields ?? [], data.snapshot),
    capViewable(viewable, ceiling && new Set([...ceiling, ...profile])),
  );
}

function pick(source: Readonly<Row>, fields: readonly string[]): Row {
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]),
  );
}

/** 详情公布的动作与命令执行共用同一套判定（rules.ts），不公布执行不了的动作（X-15 / X-16 / F14 / F16）。 */
function actionsFor(
  data: DetailData,
  userId: string,
  blind: boolean,
  viewable: ReadonlySet<string> | undefined,
): { actions: string[]; edit: EditSurface | null } {
  const { instance, version, allTasks } = data;
  const actions: string[] = [];
  let edit: EditSurface | null = null;
  const running = instance.status === 'running';
  const mine = allTasks.find((task) => task.status === 'pending' && task.assigneeUserId === userId);
  const node = version.nodes.find((candidate) => candidate.key === (mine?.nodeKey ?? instance.currentNodeKey));
  // F-048 §6 #25：办理类动作按节点级（异常管理员任务按实例级），管理员类按实例级——与命令执行同一判定（recusal.ts）
  const who = { userId };
  const instanceHit = instanceRecusal(who, data.recusal);
  const recusedOn = (task: TaskRow): boolean => {
    if (task.isExceptionAdmin) return instanceHit;
    const taskNode = version.nodes.find((candidate) => candidate.key === task.nodeKey);
    return taskNode !== undefined && nodeRecusal(taskNode, who, data.recusal) !== null;
  };
  const recused = mine !== undefined && recusedOn(mine);
  // DEC-058：被回避的人不能审批（节点开关 avoidSelf / avoidSubjects，关闭的节点照常办理）；看不到本单变化字段的人
  // （盲审，C-非4）也不显示同意 / 驳回，只能转交。
  const decide = !recused && !blind;
  if (running && mine && node) {
    // DEC-144：同意 / 不同意是出口动作，按节点配置公布；会签节点的前加签人不计入流转规则，不公布不同意（DEC-152）。
    // 驳回是节点开关（F-003 第二轮），加签人沿用原节点开关。
    const votes = !isCountersign(node) || votesInTransition(allTasks, mine);
    if (decide && hasApproveExit(node)) actions.push('approve');
    if (decide && votes && hasExit(node, 'disagree')) actions.push('disagree');
    if (decide && rejectAllowed(node)) actions.push('reject');
    // DEC-318 K-39：驳回到上一步（单人节点、非第一个节点）、审批人跳转按节点开关公布，与命令同一判定
    const first = version.nodes[0]?.key === node.key;
    if (decide && rejectToPreviousAllowed(node) && !isCountersign(node) && !first && !addSignLink(allTasks, mine)) {
      actions.push('rejectPrevious');
    }
    if (decide && jumpAllowed(node) && !addSignLink(allTasks, mine)) actions.push('jump');
    if (!recused && (node.actions.transfer || mine.isExceptionAdmin)) actions.push('transfer');
    if (decide && node.actions.addSign && addSignAllowed(allTasks, mine)) actions.push('addSign');
    // `14` §11.3：加签人不能编辑表单内容，只有本节点原审批人可以；DEC-105：员工信息类不开放编辑。F-291：独立编辑按钮与
    // 详情下发的 form.edit 同一判定（edit-surface.ts），交集为空（查看人看不到任何可编辑字段）时都不公布。
    if (decide) {
      edit = editSurface({
        approvalType: data.snapshot.approvalType,
        node,
        tasks: allTasks,
        mine,
        values: data.snapshot.values,
        viewable,
      });
      if (edit?.mode === 'separate') actions.push('edit');
    }
    if (!recused && node.actions.copySend) actions.push('cc');
  }
  const retrievable = retrievableTask(instance, version, allTasks, userId);
  if (retrievable && !recusedOn(retrievable)) actions.push('retrieve');
  if (instance.initiatorUserId === userId) actions.push(...initiatorActions(data, userId));
  // DEC-092 / DEC-329②：本人发起或本人为本单涵盖主体的申请，不公布管理员转交 / 干预。
  if (running && !instanceHit && data.admin.transfer) actions.push('adminTransfer');
  if (running && !instanceHit && data.admin.intervene) actions.push('adminIntervene');
  return { actions, edit };
}

function initiatorActions({ instance, version }: DetailData, userId: string): string[] {
  const actions: string[] = [];
  // DEC-318 K-39：撤回按当前节点的开关（isRevoke，缺省开启）
  const current = version.nodes.find((node) => node.key === instance.currentNodeKey);
  if (!approvalWithdrawalFailure(instance, userId, current)) actions.push('withdraw');
  // X-16：任职申请只能在申请单上修改后提交，审批侧不公布执行不了的“重提”；员工子集变更撤回后也可沿原实例重提（F9），
  // 发展计划驳回或撤回后由所有者沿原实例重提（DEC-318 K-39）。
  const sameInstance = ['personnel_change', 'idp'].includes(instance.businessType);
  if (sameInstance && ['returned', 'withdrawn'].includes(instance.status)) actions.push('resubmit');
  if (urgeOpen(instance, version)) actions.push('urge');
  return actions;
}

/**
 * 已办读取的值投影（F-476 P6）：办理份里的扩展（显示标签、批行内列）并进表单值；现值与未接扩展的类型原样返回。
 * rowViewable = 查看人当前对 Offer 对象的字段权限（只批行内列用，undefined = 不受约束）。
 */
function frozenValues(
  data: DetailData,
  values: Row,
  disclosed: ReadonlySet<string>,
  rowViewable: ReadonlySet<string> | undefined,
): Row {
  if (data.content.mode !== 'frozen') return values;
  const { frozen } = data.content;
  if (data.instance.businessType === 'offer') return projectOfferValues(frozen, values, disclosed);
  if (data.instance.businessType === 'offer_batch') return projectBatchValues(frozen, values, rowViewable);
  return values;
}

/** 表单下发的字段：节点表单 ∩ 字段查看权；DEC-195：两项日期沿用生效日期的节点表单与字段查看权限，不扩展审批快照。 */
function formFields(data: DetailData, userId: string, viewable: ReadonlySet<string> | undefined) {
  const disclosed = disclosedFields(data, userId, viewable);
  const fields = [...disclosed];
  if (data.instance.status === 'approved' && disclosed.has('effectiveDate'))
    fields.push('originalEffectiveDate', 'actualEffectiveDate');
  return { disclosed, fields };
}

/**
 * 只取表单值（F-476 P6 单 Offer 已办详情）：与 detailView 的 form.values 同一裁剪、同一冻结投影，但不推算操作按钮——
 * 冻结读不回 actions，取回 / 转交 / 管理员等按钮判定不进这条读路径。
 */
export function formValuesView(
  data: DetailData,
  userId: string,
  viewable: ReadonlySet<string> | undefined,
  rowViewable?: ReadonlySet<string>,
): Row {
  const { disclosed, fields } = formFields(data, userId, viewable);
  return frozenValues(data, pick(data.snapshot.values, fields), disclosed, rowViewable);
}

export function detailView(
  data: DetailData,
  userId: string,
  viewable: ReadonlySet<string> | undefined,
  pathFacts: PathFacts = NO_PATH_FACTS,
  rowViewable?: ReadonlySet<string>,
) {
  const { instance, version, snapshot } = data;
  const node = viewerNode(data, userId);
  const hidden = recordsHidden(data, userId);
  const { disclosed, fields } = formFields(data, userId, viewable);
  const { actions, edit } = actionsFor(
    data,
    userId,
    blindReviewFields(snapshot.changedFields, viewable).length > 0,
    viewable,
  );
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
    tasks: visibleTasks(data, userId, data.tasks).map((task) => ({
      ...task,
      nodeName: names.get(task.nodeKey) ?? task.nodeKey,
    })),
    logs: hidden ? [] : data.logs.map((log) => projectLog(log, disclosed)),
    recordsHidden: hidden,
    commentNotice: COMMENT_NOTICE,
    contentView: contentViewOf(instance.id, data.content),
    form: {
      nodeKey: node?.key ?? null,
      values: formValuesView(data, userId, viewable, rowViewable),
      ...originals,
      ...(edit ? { edit } : {}),
    },
    actions: [...new Set(actions)],
    exits: exitsView(actions, node, data.snapshot),
    // DEC-104 / DEC-115：看不到审批记录的人不披露路径（路径会暴露已走过的节点与分支结果）
    path: hidden ? [] : pathView(version.nodes, instance.currentNodeKey, pathFacts),
  };
}

export type DetailView = ReturnType<typeof detailView>;

/**
 * 详情表单的引用字段取名（单一入口）：F-323a 起人员类别存字典 ID，在字段裁剪之后给已下发的当前值与原值并列附
 * employmentTypeName（复用任职接口的 employmentTypeNames：带租户条件、取当前名称、停用 / 软删照常取名、查不到为 null）。
 * 只加名称、不改 ID，审批中编辑与提交仍用 ID；未下发的字段没有 ID，也就不会附名称。
 */
export async function namedForm(
  tx: Tx,
  ctx: TenantContext & { readonly now: Date },
  view: DetailView,
): Promise<DetailView> {
  const named = (await employmentTypeNames(tx, ctx.tenantId, view.form)) as DetailView['form'];
  // F-479 §3.1：附件摘要与 attachmentRefs 同权限同取值（值已按节点表单 ∩ 字段查看权裁剪，没下发引用就没有摘要）
  const refs = named.values.attachmentRefs;
  const typed = {
    ...view,
    form: Array.isArray(refs)
      ? {
          ...named,
          values: { ...named.values, attachments: await attachmentSummaries(tx, ctx.tenantId, view.businessId, refs) },
        }
      : named,
  };
  // F-474-3b P2-2：调动原因 / 类型、部门、经理同样按已下发的值取名（见 reference-names.ts）
  return referenceNames(tx, ctx, view.approvalType, typed);
}

/** DEC-100：意见框旁的提示（意见默认对所有能打开详情页的人公开）。 */
export const COMMENT_NOTICE = '审批意见默认对所有能查看本单的人公开，请勿在意见中填写敏感信息';

/**
 * DEC-104「审批记录查看权限」是查看方的设置（`14` §11.9）：按 DEC-115 严格隐藏——查看人参与过的任一节点勾选了
 * 开关，或查看人是发起人且开始节点勾选了开关，即隐藏审批记录与沟通。不是审批人的人（被抄送人、范围内管理员）
 * 不受限制。
 */
interface RecordScope {
  readonly instance: Pick<InstanceRow, 'initiatorUserId'>;
  readonly version: {
    readonly hideRecordsFromInitiator: boolean;
    readonly nodes: readonly Pick<ApprovalNode, 'key' | 'hideRecords'>[];
  };
  readonly allTasks: readonly RecordTask[];
}
export function recordsHidden(data: RecordScope, userId: string): boolean {
  const participated = new Set(ownTasks(data, userId).map((task) => task.nodeKey));
  return recordsHiddenFor({
    participatedNodeHides: data.version.nodes.filter((node) => participated.has(node.key)).map((n) => n.hideRecords),
    isInitiator: data.instance.initiatorUserId === userId,
    hideFromInitiator: data.version.hideRecordsFromInitiator,
  });
}

/** DEC-115 的分页前可见性谓词；调用方实例别名为 i，任一历史参与节点隐藏即拒绝。 */
export function visibleRecordSql(userId: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM approval_process_versions v
    WHERE v.tenant_id=i.tenant_id AND v.id=i.version_id
      AND i.initiator_user_id=${userId}::uuid AND v.hide_records_from_initiator)
    AND NOT EXISTS (SELECT 1 FROM approval_tasks hidden_task
      JOIN approval_process_nodes hidden_node ON hidden_node.tenant_id=i.tenant_id
        AND hidden_node.version_id=i.version_id AND hidden_node.node_key=hidden_task.node_key
      WHERE hidden_task.tenant_id=i.tenant_id AND hidden_task.instance_id=i.id
        AND hidden_task.assignee_user_id=${userId}::uuid
        AND hidden_task.origin NOT IN ('self_skip','subject_skip') AND hidden_node.hide_records)`;
}

/** 管理员日志只读本页实例的隐藏判定事实；按冻结版本及全部历史参与节点判断，不加载业务表单或操作人姓名。 */
export async function visibleRecordInstances(tx: Tx, tenantId: string, userId: string, instanceIds: string[]) {
  if (!instanceIds.length) return new Set<string>();
  const rows = rowsOf<{
    id: string;
    initiator_user_id: string;
    hide_records_from_initiator: boolean;
    participation: { nodeKey: string; origin: TaskRow['origin']; hideRecords: boolean }[];
  }>(
    await tx.execute(sql`SELECT i.id,i.initiator_user_id,v.hide_records_from_initiator,
        COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
          'nodeKey',t.node_key,'origin',t.origin,'hideRecords',n.hide_records))
          FROM approval_tasks t
          JOIN approval_process_nodes n ON n.tenant_id=i.tenant_id
            AND n.version_id=i.version_id AND n.node_key=t.node_key
          WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id AND t.assignee_user_id=${userId}::uuid
        ),'[]'::jsonb) AS participation
      FROM approval_instances i
      JOIN approval_process_versions v ON v.tenant_id=i.tenant_id AND v.id=i.version_id
      WHERE i.tenant_id=${tenantId} AND i.id=ANY(${`{${instanceIds.join(',')}}`}::uuid[])`),
  );
  return new Set(
    rows
      .filter(
        (row) =>
          !recordsHidden(
            {
              instance: { initiatorUserId: row.initiator_user_id },
              version: {
                hideRecordsFromInitiator: row.hide_records_from_initiator,
                nodes: row.participation.map((task) => ({ key: task.nodeKey, hideRecords: task.hideRecords })),
              },
              allTasks: row.participation.map((task) => ({ ...task, assigneeUserId: userId })),
            },
            userId,
          ),
      )
      .map((row) => row.id),
  );
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
