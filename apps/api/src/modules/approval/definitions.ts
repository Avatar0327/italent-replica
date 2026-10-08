/**
 * 流程定义与版本（REQ-APV-001）：草稿可整体替换；发布后只读，只能“编辑最新版本”生成新草稿；废弃移出可用列表。
 * 发布校验见 publishViolations（DEC-018 / DEC-054）；出厂预置见 PRESET_PROCESSES（DEC-018）。
 */
import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  exitRulesOf,
  isCountersign,
  nodeExits,
  PRESET_PROCESSES,
  publishViolations,
  conditionViolations,
  avoidsSelf,
  jumpAllowed,
  rejectAllowed,
  rejectToPreviousAllowed,
  revokeAllowed,
  type ApprovalNode,
  type ApprovalTypeCode,
  type ApproverExpression,
  type ConditionItem,
  type ExitRule,
  type ExitRules,
  type NodeExit,
  type ProcessDefinition,
  type TransitionRule,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import {
  approvalError,
  assertRevision,
  auditApproval,
  emitOutbox,
  rowsOf,
  type ApprovalContext,
  type Row,
} from './context.js';
import { isAssignable } from './resolver.js';

export interface VersionView extends ProcessDefinition {
  readonly id: string;
  readonly versionNo: number;
  readonly status: 'draft' | 'published';
  readonly publishedAt: string | null;
}

export interface ProcessView {
  readonly id: string;
  readonly code: string;
  readonly approvalType: ApprovalTypeCode;
  readonly objectCode: string;
  readonly status: 'active' | 'discarded';
  readonly revision: number;
  readonly presetKey: string | null;
  readonly currentVersion: VersionView | null;
  readonly latestVersion: VersionView;
}

interface ProcessRow {
  id: string;
  code: string;
  approval_type: ApprovalTypeCode;
  object_code: string;
  status: 'active' | 'discarded';
  revision: number;
  preset_key: string | null;
  current_version_id: string | null;
  latest_version_no: number;
}

export function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

export async function loadVersion(tx: Tx, tenantId: string, versionId: string): Promise<VersionView> {
  const [version] = rowsOf(
    await tx.execute(
      sql`SELECT * FROM approval_process_versions WHERE tenant_id=${tenantId} AND id=${versionId}::uuid`,
    ),
  );
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '流程版本不完整');
  const conditions = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_process_conditions
      WHERE tenant_id=${tenantId} AND version_id=${versionId}::uuid ORDER BY item_no LIMIT 50`),
  );
  const nodes = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_process_nodes
      WHERE tenant_id=${tenantId} AND version_id=${versionId}::uuid ORDER BY seq LIMIT 50`),
  );
  const rules = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_node_message_rules
      WHERE tenant_id=${tenantId} AND version_id=${versionId}::uuid ORDER BY node_key,rule_no LIMIT 1000`),
  );
  return {
    id: String(version.id),
    versionNo: Number(version.version_no),
    status: version.status as VersionView['status'],
    publishedAt: version.published_at ? new Date(version.published_at as string).toISOString() : null,
    name: String(version.name),
    groupName: (version.group_name as string | null) ?? null,
    description: (version.description as string | null) ?? null,
    priority: Number(version.priority),
    isFallback: Boolean(version.is_fallback),
    exceptionAdminUserId: (version.exception_admin_user_id as string | null) ?? null,
    urgeEnabled: Boolean(version.urge_enabled),
    hideRecordsFromInitiator: Boolean(version.hide_records_from_initiator),
    conditions: { expression: String(version.condition_expression), items: conditions.map(conditionItem) },
    nodes: nodes.map((row) => nodeOf(row, rules)),
  };
}

export function conditionItem(row: Row): ConditionItem {
  const value = (row.value_list as string[] | null) ?? (row.value_text as string | null);
  return {
    no: Number(row.item_no),
    field: String(row.field_path),
    operator: row.operator as ConditionItem['operator'],
    value,
  };
}

function exitRuleOf(kind: unknown, value: unknown): ExitRule | undefined {
  return kind === null || kind === undefined ? undefined : { kind: kind as ExitRule['kind'], value: Number(value) };
}

/** DEC-144：只有自定义审批方式逐行落库；两种预设按出口动作生成，读出时一并给出，便于展示与判定。 */
function transitionRuleOf(row: Row, exits: readonly NodeExit[]): TransitionRule {
  const type = row.transition_rule_type as TransitionRule['type'];
  const stored: Partial<Record<NodeExit, ExitRule>> = {};
  const approve = exitRuleOf(row.approve_rule_kind, row.approve_rule_value);
  const disagree = exitRuleOf(row.disagree_rule_kind, row.disagree_rule_value);
  if (approve) stored.approve = approve;
  if (disagree) stored.disagree = disagree;
  return { type, rules: exitRulesOf({ type, rules: stored }, exits) };
}

/** 节点类型与审批人（F-003）：单人节点一个表达式，会签节点逐人解析的表达式列表与流转规则。 */
function approversOf(row: Row, exits: readonly NodeExit[]) {
  if (row.node_type !== 'countersign')
    return { kind: 'single' as const, approver: row.approver_expression as ApproverExpression };
  return {
    kind: 'countersign' as const,
    approvers: row.approver_expressions as ApproverExpression[],
    transitionRule: transitionRuleOf(row, exits),
  };
}

function nodeOf(row: Row, rules: Row[]): ApprovalNode {
  const exits = row.exits as NodeExit[];
  return {
    key: String(row.node_key),
    name: String(row.name),
    ...approversOf(row, exits),
    exits,
    noAssignee: row.no_assignee_policy as ApprovalNode['noAssignee'],
    sameAssigneeSkip: Boolean(row.same_assignee_skip),
    historySameAssigneeSkip: Boolean(row.history_same_assignee_skip),
    sameAssigneeResult: row.same_assignee_result as ApprovalNode['sameAssigneeResult'],
    historySameAssigneeResult: row.history_same_assignee_result as ApprovalNode['historySameAssigneeResult'],
    formFields: row.form_fields as string[],
    editableFields: row.editable_fields as string[],
    editMode: row.edit_mode as ApprovalNode['editMode'],
    actions: {
      transfer: Boolean(row.allow_transfer),
      addSign: Boolean(row.allow_add_sign),
      copySend: Boolean(row.allow_copy_send),
      retrieve: Boolean(row.allow_retrieve),
      reject: Boolean(row.allow_reject),
      urge: row.urge_mode as ApprovalNode['actions']['urge'],
      // 缺省开启的开关只在关闭时给出，原有流程的定义读回不变（DEC-318 K-37）
      ...(row.avoid_self === false ? { avoidSelf: false } : {}),
      ...(row.allow_revoke === false ? { revoke: false } : {}),
      ...(row.allow_reject_previous === true ? { rejectToPrevious: true } : {}),
      ...(row.allow_jump === true ? { jump: true } : {}),
    },
    rejectCommentRequired: Boolean(row.reject_comment_required),
    hideRecords: Boolean(row.hide_records),
    rejectResubmit: row.reject_resubmit_mode as ApprovalNode['rejectResubmit'],
    messageRules: rules
      .filter((rule) => rule.node_key === row.node_key)
      .map((rule) => ({
        trigger: rule.trigger as ApprovalNode['messageRules'][number]['trigger'],
        channels: rule.channels as ApprovalNode['messageRules'][number]['channels'],
        template: String(rule.template_code),
        recipient: rule.recipient as ApprovalNode['messageRules'][number]['recipient'],
      })),
  };
}

async function processRow(tx: Tx, tenantId: string, id: string, lock = false): Promise<ProcessRow> {
  const [row] = rowsOf<ProcessRow>(
    await tx.execute(sql`SELECT * FROM approval_processes WHERE tenant_id=${tenantId} AND id=${id}::uuid
      ${lock ? sql`FOR UPDATE` : sql``}`),
  );
  if (!row) throw new AppError('NOT_FOUND', '流程不存在');
  return row;
}

async function versionId(tx: Tx, tenantId: string, processId: string, versionNo: number): Promise<string> {
  const [row] = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM approval_process_versions
      WHERE tenant_id=${tenantId} AND process_id=${processId}::uuid AND version_no=${versionNo}`),
  );
  if (!row) throw new AppError('SERVICE_UNAVAILABLE', '流程版本不完整');
  return row.id;
}

export async function loadProcess(tx: Tx, tenantId: string, id: string): Promise<ProcessView> {
  const row = await processRow(tx, tenantId, id);
  const latestId = await versionId(tx, tenantId, row.id, row.latest_version_no);
  const latestVersion = await loadVersion(tx, tenantId, latestId);
  const currentVersion =
    row.current_version_id === null
      ? null
      : row.current_version_id === latestId
        ? latestVersion
        : await loadVersion(tx, tenantId, row.current_version_id);
  return {
    id: row.id,
    code: row.code,
    approvalType: row.approval_type,
    objectCode: row.object_code,
    status: row.status,
    revision: Number(row.revision),
    presetKey: row.preset_key,
    currentVersion,
    latestVersion,
  };
}

export interface ProcessSummary {
  readonly id: string;
  readonly code: string;
  readonly approvalType: string;
  readonly status: string;
  readonly revision: number;
  readonly presetKey: string | null;
  readonly currentVersion: { versionNo: number; name: string; priority: number; isFallback: boolean } | null;
  readonly latestVersion: { versionNo: number; status: string; name: string };
}

/** 列表同时给出“当前生效版本”和“最新版本状态”（REQ-APV-001 R6）。 */
export async function listProcesses(
  tx: Tx,
  tenantId: string,
  filter: { status: 'active' | 'discarded'; approvalType?: string },
  page: { limit: number; offset: number },
): Promise<ProcessSummary[]> {
  const rows = rowsOf(
    await tx.execute(sql`SELECT p.*,cv.version_no AS current_no,cv.name AS current_name,cv.priority AS current_priority,
        cv.is_fallback AS current_fallback,lv.status AS latest_status,lv.name AS latest_name
      FROM approval_processes p
      JOIN approval_process_versions lv ON lv.tenant_id=p.tenant_id AND lv.process_id=p.id
        AND lv.version_no=p.latest_version_no
      LEFT JOIN approval_process_versions cv ON cv.tenant_id=p.tenant_id AND cv.id=p.current_version_id
      WHERE p.tenant_id=${tenantId} AND p.status=${filter.status}
        ${filter.approvalType ? sql`AND p.approval_type=${filter.approvalType}` : sql``}
      ORDER BY p.approval_type,cv.priority NULLS LAST,p.code LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return rows.map((row) => ({
    id: String(row.id),
    code: String(row.code),
    approvalType: String(row.approval_type),
    status: String(row.status),
    revision: Number(row.revision),
    presetKey: (row.preset_key as string | null) ?? null,
    currentVersion:
      row.current_no === null
        ? null
        : {
            versionNo: Number(row.current_no),
            name: String(row.current_name),
            priority: Number(row.current_priority),
            isFallback: Boolean(row.current_fallback),
          },
    latestVersion: {
      versionNo: Number(row.latest_version_no),
      status: String(row.latest_status),
      name: String(row.latest_name),
    },
  }));
}

/** 节点类型相关的列（F-003）：会签的自定义审批方式逐行落库，预设只存类型（DEC-144）。 */
function nodeTypeColumns(node: ApprovalNode) {
  if (!isCountersign(node)) {
    return { type: 'single', approver: node.approver, approvers: [] as string[], rule: null, custom: {} as ExitRules };
  }
  const custom = node.transitionRule.type === 'custom' ? (node.transitionRule.rules ?? {}) : {};
  return {
    type: 'countersign',
    approver: null,
    approvers: [...node.approvers],
    rule: node.transitionRule.type,
    custom,
  };
}

async function writeVersionContent(tx: Tx, tenantId: string, id: string, definition: ProcessDefinition) {
  for (const item of definition.conditions.items) {
    const list = Array.isArray(item.value) ? textArray(item.value as string[]) : sql`NULL`;
    const single = typeof item.value === 'string' ? item.value : null;
    await tx.execute(sql`INSERT INTO approval_process_conditions
      (tenant_id,version_id,item_no,field_path,operator,value_text,value_list)
      VALUES (${tenantId},${id}::uuid,${item.no},${item.field},${item.operator},${single},${list})`);
  }
  for (const [index, node] of definition.nodes.entries()) {
    const typed = nodeTypeColumns(node);
    const { approve, disagree } = typed.custom;
    await tx.execute(sql`INSERT INTO approval_process_nodes
      (tenant_id,version_id,node_key,seq,name,node_type,approver_expression,approver_expressions,exits,
       transition_rule_type,approve_rule_kind,approve_rule_value,disagree_rule_kind,disagree_rule_value,
       no_assignee_policy,same_assignee_skip,
       history_same_assignee_skip,same_assignee_result,history_same_assignee_result,form_fields,editable_fields,
       edit_mode,allow_transfer,allow_add_sign,allow_copy_send,allow_retrieve,allow_reject,urge_mode,
       reject_comment_required,hide_records,reject_resubmit_mode,avoid_self,allow_revoke,allow_reject_previous,
       allow_jump)
      VALUES (${tenantId},${id}::uuid,${node.key},${index + 1},${node.name},${typed.type},${typed.approver},
        ${textArray(typed.approvers)},${textArray(nodeExits(node))},${typed.rule},${approve?.kind ?? null},
        ${approve?.value ?? null},${disagree?.kind ?? null},${disagree?.value ?? null},${node.noAssignee},
        ${node.sameAssigneeSkip},${node.historySameAssigneeSkip},${node.sameAssigneeResult},
        ${node.historySameAssigneeResult},${textArray(node.formFields)},${textArray(node.editableFields)},
        ${node.editMode},${node.actions.transfer},${node.actions.addSign},${node.actions.copySend},
        ${node.actions.retrieve},${rejectAllowed(node)},${node.actions.urge},${node.rejectCommentRequired},
        ${node.hideRecords},${node.rejectResubmit},${avoidsSelf(node)},${revokeAllowed(node)},
        ${rejectToPreviousAllowed(node)},${jumpAllowed(node)})`);
    for (const [ruleIndex, rule] of node.messageRules.entries()) {
      await tx.execute(sql`INSERT INTO approval_node_message_rules
        (tenant_id,version_id,node_key,rule_no,trigger,channels,template_code,recipient)
        VALUES (${tenantId},${id}::uuid,${node.key},${ruleIndex + 1},${rule.trigger},${textArray(rule.channels)},
          ${rule.template},${rule.recipient})`);
    }
  }
}

async function insertVersion(
  tx: Tx,
  ctx: ApprovalContext,
  processId: string,
  versionNo: number,
  definition: ProcessDefinition,
): Promise<string> {
  const id = randomUUID();
  await tx.execute(sql`INSERT INTO approval_process_versions
    (id,tenant_id,process_id,version_no,status,name,group_name,description,priority,is_fallback,
     exception_admin_user_id,urge_enabled,hide_records_from_initiator,condition_expression,created_by,created_at)
    VALUES (${id},${ctx.tenantId},${processId}::uuid,${versionNo},'draft',${definition.name},${definition.groupName},
      ${definition.description},${definition.priority},${definition.isFallback},${definition.exceptionAdminUserId},
      ${definition.urgeEnabled},${definition.hideRecordsFromInitiator},${definition.conditions.expression},
      ${ctx.userId},${ctx.now.toISOString()})`);
  await writeVersionContent(tx, ctx.tenantId, id, definition);
  return id;
}

async function audited(
  tx: Tx,
  ctx: ApprovalContext,
  action: string,
  before: ProcessView | null,
  processId: string,
): Promise<ProcessView> {
  const after = await loadProcess(tx, ctx.tenantId, processId);
  await auditApproval(tx, ctx, {
    action: `approval.process.${action}`,
    objectType: 'approval-process',
    objectId: processId,
    before: before ? snapshot(before) : null,
    after: snapshot(after),
  });
  await emitOutbox(tx, ctx, {
    objectType: 'approval-process',
    objectId: processId,
    eventType: `approval.process.${action}`,
    revision: after.revision,
  });
  return after;
}

function snapshot(view: ProcessView): Row {
  const { latestVersion, currentVersion, ...rest } = view;
  return { ...rest, latestVersion, currentVersionNo: currentVersion?.versionNo ?? null };
}

export async function createProcess(
  tx: Tx,
  ctx: ApprovalContext,
  input: { code: string; approvalType: ApprovalTypeCode; presetKey?: string },
  definition: ProcessDefinition,
): Promise<ProcessView> {
  assertRevision(ctx.expectedRevision, 0);
  const id = randomUUID();
  // X-21：并发创建同编码（或同一预置）时由唯一约束裁决，冲突返回 409 而不是 500。
  const inserted = rowsOf(
    await tx.execute(sql`INSERT INTO approval_processes
    (id,tenant_id,code,approval_type,object_code,preset_key,created_by,created_at)
    VALUES (${id},${ctx.tenantId},${input.code},${input.approvalType},${APPROVAL_TYPES[input.approvalType].objectCode},
      ${input.presetKey ?? null},${ctx.userId},${ctx.now.toISOString()})
    ON CONFLICT DO NOTHING RETURNING id`),
  );
  if (!inserted.length) throw approvalError('CONFLICT', 'APPROVAL_CODE_DUPLICATE', '流程编码已存在');
  await insertVersion(tx, ctx, id, 1, definition);
  return audited(tx, ctx, 'create', null, id);
}

async function lockedForChange(tx: Tx, ctx: ApprovalContext, id: string) {
  const row = await processRow(tx, ctx.tenantId, id, true);
  assertRevision(ctx.expectedRevision, Number(row.revision));
  if (row.status === 'discarded') throw approvalError('CONFLICT', 'APPROVAL_PROCESS_DISCARDED', '流程已废弃');
  const before = await loadProcess(tx, ctx.tenantId, id);
  return { row, before };
}

async function bump(tx: Tx, ctx: ApprovalContext, id: string, set: SQL = sql``) {
  await tx.execute(sql`UPDATE approval_processes SET revision=revision+1 ${set}
    WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`);
}

export async function replaceDraft(tx: Tx, ctx: ApprovalContext, id: string, definition: ProcessDefinition) {
  const { before } = await lockedForChange(tx, ctx, id);
  const draft = before.latestVersion;
  if (draft.status !== 'draft') {
    throw approvalError('CONFLICT', 'APPROVAL_VERSION_PUBLISHED', '已发布的流程不能直接修改，请先编辑最新版本');
  }
  for (const table of ['approval_node_message_rules', 'approval_process_nodes', 'approval_process_conditions']) {
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)}
      WHERE tenant_id=${ctx.tenantId} AND version_id=${draft.id}::uuid`);
  }
  await tx.execute(sql`UPDATE approval_process_versions SET name=${definition.name},group_name=${definition.groupName},
      description=${definition.description},priority=${definition.priority},is_fallback=${definition.isFallback},
      exception_admin_user_id=${definition.exceptionAdminUserId},urge_enabled=${definition.urgeEnabled},
      hide_records_from_initiator=${definition.hideRecordsFromInitiator},
      condition_expression=${definition.conditions.expression}
    WHERE tenant_id=${ctx.tenantId} AND id=${draft.id}::uuid`);
  await writeVersionContent(tx, ctx.tenantId, draft.id, definition);
  await bump(tx, ctx, id);
  return audited(tx, ctx, 'draft.update', before, id);
}

/** 编辑最新版本：以当前生效版本为底稿生成下一版草稿（`14` §4 原文）。 */
export async function newVersion(tx: Tx, ctx: ApprovalContext, id: string) {
  const { row, before } = await lockedForChange(tx, ctx, id);
  if (before.latestVersion.status === 'draft') {
    throw approvalError('CONFLICT', 'APPROVAL_DRAFT_EXISTS', '最新版本已是草稿，请直接编辑');
  }
  const next = Number(row.latest_version_no) + 1;
  await insertVersion(tx, ctx, id, next, before.latestVersion);
  await bump(tx, ctx, id, sql`,latest_version_no=${next}`);
  return audited(tx, ctx, 'version.create', before, id);
}

export async function publishProcess(tx: Tx, ctx: ApprovalContext, id: string) {
  const { before } = await lockedForChange(tx, ctx, id);
  const draft = before.latestVersion;
  if (draft.status !== 'draft') throw approvalError('CONFLICT', 'APPROVAL_VERSION_PUBLISHED', '最新版本已发布');
  if (before.approvalType.startsWith('contract_')) {
    const [unsupported] = conditionViolations(draft.conditions, APPROVAL_TYPES[before.approvalType].conditionFields);
    if (unsupported) throw approvalError('VALIDATION_FAILED', 'APPROVAL_CONDITION_UNSUPPORTED', unsupported);
  }
  const [violation] = publishViolations(draft);
  if (violation) throw approvalError('VALIDATION_FAILED', violation.reason, violation.message);
  await assertExceptionAdminMember(tx, ctx.tenantId, draft.exceptionAdminUserId!);
  if (!draft.isFallback) await assertUniquePriority(tx, ctx.tenantId, before, draft.priority);
  await tx.execute(sql`UPDATE approval_process_versions SET status='published',published_by=${ctx.userId},
      published_at=${ctx.now.toISOString()}
    WHERE tenant_id=${ctx.tenantId} AND id=${draft.id}::uuid`);
  await bump(tx, ctx, id, sql`,current_version_id=${draft.id}::uuid`);
  return audited(tx, ctx, 'publish', before, id);
}

/**
 * DEC-096：同类型普通流程优先级相同禁止发布（兜底流程始终排在最后，不参与比较）。
 * 同租户同类型的发布以事务级咨询锁串行，避免并发发布出两个同优先级流程。
 */
async function assertUniquePriority(tx: Tx, tenantId: string, process: ProcessView, priority: number) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`approval_priority:${tenantId}:${process.approvalType}`}, 0))`,
  );
  const [tie] = rowsOf<{ code: string }>(
    await tx.execute(sql`SELECT p.code FROM approval_processes p
      JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND v.id=p.current_version_id
      WHERE p.tenant_id=${tenantId} AND p.status='active' AND p.approval_type=${process.approvalType}
        AND p.id<>${process.id}::uuid AND NOT v.is_fallback AND v.priority=${priority} LIMIT 1`),
  );
  if (tie) {
    throw approvalError('CONFLICT', 'APPROVAL_PRIORITY_DUPLICATE', `与流程 ${tie.code} 的优先级相同，请调整后再发布`);
  }
}

/**
 * DEC-098 交接：以当前生效版本为底稿生成并发布下一版，只替换异常管理员；最新版本是草稿时拒绝（先处理草稿）。
 */
export async function republishWithExceptionAdmin(tx: Tx, ctx: ApprovalContext, id: string, userId: string) {
  const row = await processRow(tx, ctx.tenantId, id, true);
  const before = await loadProcess(tx, ctx.tenantId, id);
  if (before.latestVersion.status === 'draft' || !before.currentVersion) {
    throw approvalError('CONFLICT', 'APPROVAL_DRAFT_EXISTS', `流程 ${row.code} 有未发布的草稿，请先处理后再交接`);
  }
  const next = Number(row.latest_version_no) + 1;
  const versionId = await insertVersion(tx, ctx, id, next, { ...before.currentVersion, exceptionAdminUserId: userId });
  await tx.execute(sql`UPDATE approval_process_versions SET status='published',published_by=${ctx.userId},
      published_at=${ctx.now.toISOString()}
    WHERE tenant_id=${ctx.tenantId} AND id=${versionId}::uuid`);
  await bump(tx, ctx, id, sql`,latest_version_no=${next},current_version_id=${versionId}::uuid`);
  return audited(tx, ctx, 'exception_admin.handover', before, id);
}

/** 异常管理员须可派：成员关系有效、全局账号未停用、不在停用中（取派单闸，R4-3 / R5-1）。 */
export async function assertExceptionAdminMember(tx: Tx, tenantId: string, userId: string) {
  if (!(await isAssignable(tx, tenantId, userId)))
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_EXCEPTION_ADMIN_INVALID', '异常管理员必须是本租户有效成员');
}

/** 废弃：从可用列表移除且不再参与匹配；在途实例按其冻结版本继续（R3）。 */
export async function discardProcess(tx: Tx, ctx: ApprovalContext, id: string) {
  const { before } = await lockedForChange(tx, ctx, id);
  await bump(tx, ctx, id, sql`,status='discarded'`);
  return audited(tx, ctx, 'discard', before, id);
}

/** 安装出厂预置流程（幂等）；TODO(R1-T17)：租户开通时由平台层自动调用。 */
export async function installPresets(tx: Tx, ctx: ApprovalContext): Promise<ProcessView[]> {
  // F17：与其他创建命令一致，只接受 If-Match: 0。
  assertRevision(ctx.expectedRevision, 0);
  const views: ProcessView[] = [];
  for (const preset of PRESET_PROCESSES) {
    const [existing] = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM approval_processes
        WHERE tenant_id=${ctx.tenantId} AND preset_key=${preset.presetKey}`),
    );
    views.push(
      existing
        ? await loadProcess(tx, ctx.tenantId, existing.id)
        : await createProcess(
            tx,
            { ...ctx, expectedRevision: 0 },
            { code: preset.code, approvalType: preset.approvalType, presetKey: preset.presetKey },
            preset.definition,
          ).catch(async (error: unknown) => {
            // 并发安装：另一方已先装好（唯一约束裁决），返回已有的预置，保持幂等。
            const [raced] = rowsOf<{ id: string }>(
              await tx.execute(sql`SELECT id FROM approval_processes
                WHERE tenant_id=${ctx.tenantId} AND preset_key=${preset.presetKey}`),
            );
            if (!raced) throw error;
            return loadProcess(tx, ctx.tenantId, raced.id);
          }),
    );
  }
  return views;
}
