/**
 * 审批详情与最小披露（DEC-057，REQ-APV-003 R3/R4）：只显示查看人所在节点的表单字段，并按其字段权限裁剪；
 * 变更前原值受租户开关「审批详情页显示原信息」控制；审批不产生任何数据范围（`11` §16）。
 * 盲审（DEC-058）：本单变化字段中有查看人不可见的字段即为盲审。
 */
import { sql, type Tx } from '@italent/db';
import type { ApprovalNode } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { ADAPTERS, type BusinessSnapshot } from './adapters.js';
import { rowsOf, type ApprovalContext, type Row } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import { userOfPerson } from './resolver.js';
import { loadInstance, loadLogs, loadTasks, type InstanceRow, type TaskRow } from './store.js';

export const SHOW_ORIGINALS_SETTING = 'approval.show_original_values';

export interface Viewer {
  readonly userId: string;
  /** 管理员（持有转交 / 干预按钮）且实例员工在其数据范围内时的 SQL 判定；非管理员为 null。 */
  readonly adminScope: SQL | null;
}

export interface DetailData {
  readonly instance: InstanceRow;
  readonly version: VersionView;
  readonly snapshot: BusinessSnapshot;
  readonly tasks: readonly TaskRow[];
  readonly logs: Awaited<ReturnType<typeof loadLogs>>;
  readonly showOriginals: boolean;
  readonly isAdmin: boolean;
  readonly subjectUserId: string | null;
}

export function blindFields(snapshot: BusinessSnapshot, viewable: ReadonlySet<string> | undefined): string[] {
  return viewable === undefined ? [] : snapshot.changedFields.filter((field) => !viewable.has(field));
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
  const tasks = await loadTasks(tx, ctx.tenantId, instanceId);
  // C-非3：被自审跳过的人只是留痕，不因此成为参与人。
  const participant =
    instance.initiatorUserId === viewer.userId ||
    tasks.some((task) => task.assigneeUserId === viewer.userId && task.origin !== 'self_skip');
  const isAdmin = await adminCovers(tx, ctx.tenantId, instanceId, viewer.adminScope);
  if (!participant && !isAdmin) throw new AppError('NOT_FOUND', '审批实例不存在');
  const setting = await readEffectiveSetting(tx, ctx.tenantId, SHOW_ORIGINALS_SETTING);
  return {
    instance,
    version: await loadVersion(tx, ctx.tenantId, instance.versionId),
    snapshot: await ADAPTERS[instance.businessType].snapshot(tx, ctx, instance.businessId),
    tasks,
    logs: await loadLogs(tx, ctx.tenantId, instanceId),
    showOriginals: setting.value === true,
    isAdmin,
    subjectUserId: await userOfPerson(tx, ctx.tenantId, instance.subjectEmployeeId),
  };
}

function viewerNode(data: DetailData, userId: string): ApprovalNode | null {
  const own = data.tasks.filter((task) => task.assigneeUserId === userId && task.origin !== 'self_skip').at(-1);
  const key = own?.nodeKey ?? data.instance.currentNodeKey ?? data.tasks.at(-1)?.nodeKey ?? data.version.nodes[0]?.key;
  return data.version.nodes.find((node) => node.key === key) ?? null;
}

function pick(source: Readonly<Row>, fields: readonly string[]): Row {
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(source, field)).map((field) => [field, source[field]]),
  );
}

function actionsFor(data: DetailData, userId: string, blind: boolean): string[] {
  const { instance, version } = data;
  const actions: string[] = [];
  const running = instance.status === 'running';
  const mine = data.tasks.find((task) => task.status === 'pending' && task.assigneeUserId === userId);
  const node = version.nodes.find((candidate) => candidate.key === (mine?.nodeKey ?? instance.currentNodeKey));
  // DEC-058：发起人或异动本人不能审批；看不到本单变化字段的人（盲审，C-非4）也不显示同意 / 驳回，只能转交。
  const decide = !(userId === instance.initiatorUserId || userId === data.subjectUserId) && !blind;
  if (running && mine && node) {
    if (decide) actions.push('approve', 'reject');
    if (node.actions.transfer || mine.isExceptionAdmin) actions.push('transfer');
    if (decide && node.actions.addSign) actions.push('addSign');
    if (decide && node.editMode === 'separate') actions.push('edit');
  }
  if (instance.initiatorUserId === userId && ['running', 'returned'].includes(instance.status)) {
    actions.push('withdraw');
    if (instance.status === 'returned') actions.push('resubmit');
    if (running && version.urgeEnabled && node?.actions.urge) actions.push('urge');
  }
  if (running && data.isAdmin) actions.push('adminTransfer', 'adminIntervene');
  return actions;
}

export function detailView(data: DetailData, userId: string, viewable: ReadonlySet<string> | undefined) {
  const { instance, version, snapshot } = data;
  const node = viewerNode(data, userId);
  const fields = (node?.formFields ?? []).filter((field) => viewable === undefined || viewable.has(field));
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
    tasks: data.tasks.map((task) => ({ ...task, nodeName: names.get(task.nodeKey) ?? task.nodeKey })),
    logs: data.logs.map((log) => projectLog(log, viewable)),
    form: { nodeKey: node?.key ?? null, values: pick(snapshot.values, fields), ...originals },
    actions: [...new Set(actionsFor(data, userId, blindFields(snapshot, viewable).length > 0))],
  };
}

/** X-13：日志里的字段名（盲审、编辑）按查看人当前字段权限投影；完整信息只留在内部审计。 */
function projectLog<T extends { detail: Row }>(log: T, viewable: ReadonlySet<string> | undefined): T {
  const fields = log.detail.fields;
  if (viewable === undefined || !Array.isArray(fields)) return log;
  return { ...log, detail: { ...log.detail, fields: fields.filter((field) => viewable.has(String(field))) } };
}

export type InstanceView = ReturnType<typeof detailView>;
