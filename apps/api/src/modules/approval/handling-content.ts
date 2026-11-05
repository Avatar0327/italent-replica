/**
 * 审批办理份（F-476，DEC-781）：办理人完成一次办理动作时，同事务冻结“他办理时看到的内容”；已办读取这份，在办读现值。
 * 设计：docs/08_设计/F-476_审批办理时冻结快照_设计.md §5、§6.0。
 *
 * - 内容 = { snapshot, ext }：snapshot 是整份审批业务快照（含编辑后的候选态），ext 是业务专属扩展（组织调整的头 / 明细 / 名称）。
 * - provider 注册表按 BusinessType 全量登记（缺一个编译不过）：本片每个已有类型都有“最小 provider”（整份通用审批表单），
 *   组织调整另带完整扩展；未接入的类型显式标 not-wired，办理时 503 失败闭合，不拿空内容冒充已冻结。
 * - 顺序：校验 → 准备内容（业务状态还没被本次办理推进）→ 关任务 / 回调 → 写日志 → 写办理份。写入失败整笔办理回滚。
 * - 读取：见 selectContent；缺份 503，不退回现值（DEC-807）。
 */
import { createHash } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { loadOrgContent } from '../org-adjustment/content.js';
import type { BusinessSnapshot, BusinessType } from './adapters.js';
import { approvalError, rowsOf, type ApprovalContext } from './context.js';
import { loadVersion, type VersionView } from './definitions.js';
import type { Run } from './engine.js';
import type { InstanceRow, TaskRow } from './store.js';

export const CONTENT_SCHEMA_VERSION = 1;
/** payload 上限 16 MiB（与表 check 一致）；超限 413，不截断。 */
export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export interface HandlingContent {
  readonly snapshot: BusinessSnapshot;
  readonly ext: unknown;
}

type ExtLoader = (tx: Tx, tenantId: string, businessId: string) => Promise<unknown>;
type ContentProvider =
  | { readonly kind: 'snapshot-only' }
  | { readonly kind: 'extended'; readonly ext: ExtLoader }
  | { readonly kind: 'not-wired'; readonly reason: string };

const SNAPSHOT_ONLY: ContentProvider = { kind: 'snapshot-only' };

/**
 * 办理份 provider（必须全量登记）。snapshot-only：该类型的通用审批表单整份保存（P1 最小 provider），业务专属扩展
 * （IDP 计划明细、交接清单等）随各自业务片接入；这不代表该类型的内容已完整冻结。
 */
export const CONTENT_PROVIDERS: Readonly<Record<BusinessType, ContentProvider>> = {
  org_adjustment: { kind: 'extended', ext: (tx, tenantId, id) => loadOrgContent(tx, tenantId, id) },
  employment: SNAPSHOT_ONLY,
  personnel_change: SNAPSHOT_ONLY,
  contract: SNAPSHOT_ONLY,
  idp: SNAPSHOT_ONLY,
  part_time: SNAPSHOT_ONLY,
  offer: SNAPSHOT_ONLY,
  offer_batch: SNAPSHOT_ONLY,
  probation_assessment: SNAPSHOT_ONLY,
  retirement_intention: SNAPSHOT_ONLY,
  exit_handover: SNAPSHOT_ONLY,
  // 结果审批尚无真实 provider（适配器本身是占位，不可发起）：到达这里一律拒绝，不写空份
  talent_review: { kind: 'not-wired', reason: '盘点结果审批的办理份 provider 尚未接入' },
};

export type HandlingAction =
  'approve' | 'disagree' | 'reject' | 'reject_previous' | 'jump' | 'transfer' | 'add_sign_before' | 'add_sign_after';

/** 视为“办理”的日志事件（选择时按它找查看人最近一次办理）；管理员事件与引擎系统日志不是办理锚点。 */
export const HANDLING_EVENTS: readonly string[] = [
  'approve',
  'disagree',
  'reject',
  'reject_previous',
  'jump',
  'transfer',
  'add_sign_before',
];

export interface PreparedContent {
  readonly json: string;
  readonly bytes: number;
  readonly digest: string;
  /** 办理人当时的可见字段集合（披露上限）；null = 不受字段权限约束。 */
  readonly ceiling: string[] | null;
  readonly businessVersion: string;
}

/**
 * 准备办理份（必须在本次办理推进业务状态之前调用）：读取业务内容、序列化、计算大小与摘要。
 * 编辑并同意时，run.snapshot 已是编辑后的候选态（applyEdit 重取）。
 */
export async function prepareHandlingContent(
  tx: Tx,
  run: Run,
  viewable: ReadonlySet<string> | undefined,
): Promise<PreparedContent> {
  const { instance, snapshot, ctx } = run;
  const provider = CONTENT_PROVIDERS[instance.businessType];
  if (provider.kind === 'not-wired') {
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_CONTENT_NOT_WIRED', '该类审批暂不能办理', {
      businessType: instance.businessType,
    });
  }
  const ext = provider.kind === 'extended' ? await provider.ext(tx, ctx.tenantId, instance.businessId) : null;
  const json = JSON.stringify({ snapshot, ext } satisfies HandlingContent);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw approvalError('PAYLOAD_TOO_LARGE', 'APPROVAL_CONTENT_TOO_LARGE', '本单内容过大，无法保存办理记录', {
      limit: MAX_PAYLOAD_BYTES,
    });
  }
  return {
    json,
    bytes,
    digest: createHash('sha256').update(json).digest('hex'),
    ceiling: viewable ? [...viewable].sort() : null,
    businessVersion: snapshot.version,
  };
}

/** 办理份的锚点：关闭的任务与本次办理写下的那条日志。 */
export interface HandlingAnchor {
  readonly logId: string;
  readonly task: TaskRow;
  readonly action: HandlingAction;
}

/** 写办理份（调用方已写好办理日志）。唯一约束 / 守卫触发器把任务、日志、实例的一致性兜在库里。 */
export async function recordHandlingContent(
  tx: Tx,
  run: Run,
  prepared: PreparedContent,
  anchor: HandlingAnchor,
): Promise<void> {
  const { ctx, instance } = run;
  const { task } = anchor;
  const actor = ctx.actorUserId === undefined ? ctx.userId : ctx.actorUserId;
  await tx.execute(sql`INSERT INTO approval_handling_contents
    (tenant_id,instance_id,task_id,handling_log_id,round,node_key,activation_id,process_version_id,actor_user_id,
     handling_kind,action,business_type,business_id,business_version,content_schema_version,content,
     disclosure_ceiling,payload_bytes,content_digest,acted_at)
    VALUES (${ctx.tenantId},${instance.id}::uuid,${task.id}::uuid,${anchor.logId}::uuid,${task.round},${task.nodeKey},
      ${task.activationId}::uuid,${instance.versionId}::uuid,${actor}::uuid,${actor ? 'human' : 'system'},
      ${anchor.action},${instance.businessType},${instance.businessId}::uuid,${prepared.businessVersion},
      ${CONTENT_SCHEMA_VERSION},${prepared.json}::jsonb,${JSON.stringify(prepared.ceiling)}::jsonb,${prepared.bytes},
      ${prepared.digest},${ctx.now.toISOString()})`);
}

/** 已办读取选中的办理份。 */
export interface FrozenContent {
  readonly id: string;
  readonly taskId: string;
  readonly round: number;
  readonly nodeKey: string;
  readonly actedAt: string;
  readonly content: HandlingContent;
  readonly ceiling: ReadonlySet<string> | null;
  /** 办理份所属的流程版本：已办的节点表单按它取，不随实例之后的版本变化。 */
  readonly version: VersionView;
}

export type ContentSelection = { readonly mode: 'live' } | { readonly mode: 'frozen'; readonly frozen: FrozenContent };

interface HandlingRow {
  readonly logId: string;
  readonly copyId: string | null;
  readonly taskId: string | null;
  readonly round: number | null;
  readonly nodeKey: string | null;
  readonly processVersionId: string | null;
  readonly actedAt: string | null;
  readonly content: HandlingContent | null;
  readonly ceiling: string[] | null;
}

/**
 * 内容选择（设计 §5.3）：本人有待办 → 现值；发起人 → 现值；本人最近一次办理 → 该次的办理份（缺份 503）；
 * 其余（普通参与 / 抄送 / 管理员）→ 现值。被自审 / 主体跳过的留痕不算办理（日志事件不在办理集合内）。
 */
export async function selectContent(
  tx: Tx,
  ctx: Pick<ApprovalContext, 'tenantId'>,
  instance: InstanceRow,
  allTasks: readonly TaskRow[],
  userId: string,
): Promise<ContentSelection> {
  if (instance.initiatorUserId === userId) return { mode: 'live' };
  const pending = allTasks.some(
    (task) =>
      task.assigneeUserId === userId &&
      task.status === 'pending' &&
      task.origin !== 'self_skip' &&
      task.origin !== 'subject_skip',
  );
  if (pending) return { mode: 'live' };
  const [row] = rowsOf<HandlingRow>(
    await tx.execute(sql`SELECT l.id AS "logId", c.id AS "copyId", c.task_id AS "taskId", c.round,
        c.node_key AS "nodeKey", c.process_version_id AS "processVersionId", to_char(c.acted_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "actedAt", c.content, c.disclosure_ceiling AS ceiling
      FROM approval_instance_logs l
      LEFT JOIN approval_handling_contents c ON c.tenant_id = l.tenant_id AND c.handling_log_id = l.id
      WHERE l.tenant_id = ${ctx.tenantId} AND l.instance_id = ${instance.id}::uuid
        AND l.actor_user_id = ${userId}::uuid AND l.event = ANY(${`{${HANDLING_EVENTS.join(',')}}`}::text[])
      ORDER BY l.seq DESC LIMIT 1`),
  );
  if (!row) return { mode: 'live' };
  if (!row.copyId || !row.content || !row.processVersionId) {
    // DEC-807：已办缺份即失败闭合，不退回现值，也不拿更早的份顶替
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_HANDLING_CONTENT_MISSING', '办理记录暂不可读取，请稍后重试');
  }
  return {
    mode: 'frozen',
    frozen: {
      id: row.copyId,
      taskId: row.taskId!,
      round: row.round!,
      nodeKey: row.nodeKey!,
      actedAt: row.actedAt!,
      content: row.content,
      ceiling: row.ceiling ? new Set(row.ceiling) : null,
      version: await loadVersion(tx, ctx.tenantId, row.processVersionId),
    },
  };
}

/** 响应里的“内容来源”说明（设计 §5.5）：前端据此区分办理时快照与现值。 */
export function contentViewOf(instanceId: string, selection: ContentSelection) {
  if (selection.mode === 'live') return { mode: 'live' as const, instanceId, taskId: null, round: null, actedAt: null };
  const { frozen } = selection;
  return {
    mode: 'frozen' as const,
    instanceId,
    taskId: frozen.taskId,
    round: frozen.round,
    actedAt: frozen.actedAt,
  };
}

/** 披露上限与当前字段权限取交集（任一为 undefined = 不受约束）。 */
export function capViewable(
  viewable: ReadonlySet<string> | undefined,
  ceiling: ReadonlySet<string> | null,
): ReadonlySet<string> | undefined {
  if (!ceiling) return viewable;
  if (!viewable) return ceiling;
  return new Set([...viewable].filter((field) => ceiling.has(field)));
}
