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
import { loadContractContent } from '../contracts/frozen.js';
import { loadEmploymentContent } from '../employment/approval-content.js';
import { loadAssessmentContent } from '../employment/assessment-content.js';
import { loadPartTimeContent } from '../employment/part-time/request-read.js';
import { loadIntentionContent } from '../employment/retirement-intention-content.js';
import { loadIdpStageContent } from '../idp/stage-content.js';
import { loadPersonnelContent } from '../personnel/frozen.js';
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

/**
 * 第 4 个参数是办理上下文（办理人、办理时刻、租户时区）：个别业务要把「办理当时」的关联材料（如兼职的主职）一并冻结；
 * 按办理人裁剪源对象的 provider（IDP 关键信息，P2-1）从中取办理人与授权器。系统处理时办理人为空（prepareHandlingContent）。
 */
type ExtLoader = (tx: Tx, tenantId: string, businessId: string, ctx: ApprovalContext) => Promise<unknown>;
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
  employment: { kind: 'extended', ext: (tx, tenantId, id) => loadEmploymentContent(tx, tenantId, id) },
  personnel_change: { kind: 'extended', ext: loadPersonnelContent },
  contract: { kind: 'extended', ext: loadContractContent },
  idp: { kind: 'extended', ext: (tx, tenantId, stageId, ctx) => loadIdpStageContent(tx, tenantId, stageId, ctx) },
  part_time: { kind: 'extended', ext: loadPartTimeContent },
  offer: SNAPSHOT_ONLY,
  offer_batch: SNAPSHOT_ONLY,
  probation_assessment: { kind: 'extended', ext: (tx, tenantId, id) => loadAssessmentContent(tx, tenantId, id) },
  retirement_intention: { kind: 'extended', ext: (tx, tenantId, id) => loadIntentionContent(tx, tenantId, id) },
  exit_handover: SNAPSHOT_ONLY,
  // 结果审批尚无真实 provider（适配器本身是占位，不可发起）：到达这里一律拒绝，不写空份
  talent_review: { kind: 'not-wired', reason: '盘点结果审批的办理份 provider 尚未接入' },
};

export type HandlingAction =
  | 'approve'
  | 'disagree'
  | 'reject'
  | 'reject_previous'
  | 'jump'
  | 'transfer'
  | 'add_sign_before'
  | 'add_sign_after'
  // 系统处理（自动同意 / 自动跳过，设计 §1.3）：actor 为空的系统份，不是任何人的亲自办理
  | 'auto_approve'
  | 'skip';

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
  system = false,
): Promise<PreparedContent> {
  const { instance, snapshot } = run;
  // 系统处理按与写份同口径的空办理人采集，不按触发本次推进的人工操作人裁剪：无办理人也就无字段权（P8 第 6 轮、合 main）
  const ctx = system ? { ...run.ctx, actorUserId: null, fields: undefined } : run.ctx;
  const provider = CONTENT_PROVIDERS[instance.businessType];
  if (provider.kind === 'not-wired') {
    throw approvalError('SERVICE_UNAVAILABLE', 'APPROVAL_CONTENT_NOT_WIRED', '该类审批暂不能办理', {
      businessType: instance.businessType,
    });
  }
  const ext = provider.kind === 'extended' ? await provider.ext(tx, ctx.tenantId, instance.businessId, ctx) : null;
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
  /** true：系统处理（自动同意 / 跳过）。actor 固定为空，不取 ctx 的操作人，更不冒认候选人（设计 §1.3）。 */
  readonly system?: boolean;
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
  const actor = anchor.system ? null : ctx.actorUserId === undefined ? ctx.userId : ctx.actorUserId;
  // null = 办理人不受字段权限约束（不设上限），写 SQL NULL 而非 jsonb 'null'：租户备份 / 恢复按 JSON 往返，
  // 'null' 字面量会被还原成 SQL NULL（F-476 预检返工）。
  const ceiling = prepared.ceiling === null ? null : JSON.stringify(prepared.ceiling);
  await tx.execute(sql`INSERT INTO approval_handling_contents
    (tenant_id,instance_id,task_id,handling_log_id,round,node_key,activation_id,process_version_id,actor_user_id,
     handling_kind,action,business_type,business_id,business_version,content_schema_version,content,
     disclosure_ceiling,payload_bytes,content_digest,acted_at)
    VALUES (${ctx.tenantId},${instance.id}::uuid,${task.id}::uuid,${anchor.logId}::uuid,${task.round},${task.nodeKey},
      ${task.activationId}::uuid,${instance.versionId}::uuid,${actor}::uuid,${actor ? 'human' : 'system'},
      ${anchor.action},${instance.businessType},${instance.businessId}::uuid,${prepared.businessVersion},
      ${CONTENT_SCHEMA_VERSION},${prepared.json}::jsonb,${ceiling}::jsonb,${prepared.bytes},
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
