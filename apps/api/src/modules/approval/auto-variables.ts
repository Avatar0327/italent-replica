/**
 * F-326 S7a（DEC-858 ～ DEC-861）：设计器里选“指定人员”时，服务端把人员落成自动公共变量，节点库内只存 public_variable。
 * 位置（slot）= 节点 × approver / empty_approver；一个版本的一个位置最多一条未停用的自动变量（唯一索引兜底）。
 * 本文件只处理“保存时生成 / 复用 / 待生效”“发布时落地待生效值”“视图回显”和“不再被引用时停用”，
 * 不碰模拟、发布检查和实例运行（S7d / S7e）。
 */
import { and, approvalVariables as table, eq, inArray, sql, type Tx } from '@italent/db';
import {
  countersignDuplicate,
  isCountersign,
  isUnselectedSpecified,
  textViolation,
  VARIABLE_TEXT_FIELDS,
  type ApprovalNode,
  type ApproverSource,
} from '@italent/domain';
import { approvalError, canonicalId, rowsOf, type ApprovalContext } from './context.js';
import type { ProcessView, VersionView } from './definitions.js';
import { findSourceUsages } from './source-usages.js';
import { auditVariable, loadVariable, variableSelection as selection, type VariableRow } from './variables.js';

export type Slot = 'approver' | 'empty_approver';
const AUTO_DESCRIPTION = '通过指定人员自动生成的公共变量';
const RETIRE_REASON = '不再被引用';
const CODE_TRIES = 20;

/** 库内节点来源上的“待生效值”：继承变量在草稿里改人只记在节点上，发布时才写变量（DEC-861⑤）。 */
interface PendingMark {
  pendingUserIds?: readonly string[];
  pendingRevision?: number;
}
type StoredSource = ApproverSource & PendingMark;

export interface MaterializeScope {
  tenantId: string;
  versionId: string;
  processId: string;
  processCode: string;
  processName: string;
  /** 保存前草稿里的同键节点（用于找继承变量与待生效值）；新建 / 复制没有 */
  previous?: ReadonlyMap<string, ApprovalNode>;
}

// ───────── 命名 ─────────

// u 标志按码点匹配：配对代理不会命中，命中的只有未配对代理码元，换成 U+FFFD
// eslint-disable-next-line no-control-regex -- 去掉控制字符正是本函数的目的
const wellFormed = (text: string) => text.replace(/[\u0000-\u001F\u007F]/g, '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
const MAX_NAME = VARIABLE_TEXT_FIELDS.variableName.max;

/** 按码点从头截取，累计不超过 limit 个 UTF-16 码元，不拆代理对。 */
function cutUnits(text: string, limit: number): string {
  let out = '';
  for (const char of text) {
    if (out.length + char.length > limit) break;
    out += char;
  }
  return out;
}

/** “流程名-节点名”（空人位置再加“-审批人为空时”）；总长不超上限：先截流程名，流程名连一个码点都放不下时再截节点名。 */
export function autoVariableName(processName: string, nodeName: string, slot: Slot): string {
  const tail = slot === 'empty_approver' ? '-审批人为空时' : '';
  const process = wellFormed(processName);
  const node = wellFormed(nodeName) + tail;
  const budget = MAX_NAME - 1 - node.length;
  const head = cutUnits(process, budget);
  if (head) return `${head}-${node}`;
  const first = [...process][0] ?? '';
  return `${first}-${cutUnits(node, MAX_NAME - first.length - 1)}`;
}

/** 编码主干：流程编码去掉非字母数字下划线字符，非字母开头补 P，取前 51 位（加 13 位毫秒时间戳后不超 64 位）。 */
export function autoVariableStem(processCode: string): string {
  const cleaned = processCode.replace(/[^A-Za-z0-9_]/g, '');
  return (/^[A-Za-z]/.test(cleaned) ? cleaned : `P${cleaned}`).slice(0, 51);
}

// ───────── 读写变量 ─────────

const peopleOfRow = (row: Pick<VariableRow, 'defaultValue'>): string[] | null => {
  const value = row.defaultValue;
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? (value as string[]) : [value as string];
};

/** 人员集合相等（不看顺序）；空与空相等，空与非空不等。 */
function sameSet(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((id) => b.includes(id));
}

const valueFor = (dataType: string, people: readonly string[] | null) =>
  people === null ? null : dataType === 'person' ? people[0]! : [...people];

async function ownedVariable(tx: Tx, scope: MaterializeScope, nodeKey: string, slot: Slot) {
  const [row] = await tx
    .select(selection)
    .from(table)
    .where(
      and(
        eq(table.tenantId, scope.tenantId),
        eq(table.origin, 'auto'),
        eq(table.originVersionId, scope.versionId),
        eq(table.originNodeKey, nodeKey),
        eq(table.originSlot, slot),
        sql`${table.status} <> 'disabled'`,
      ),
    )
    .for('update');
  return row;
}

/** 本位置在保存前草稿里引用的、归属同一流程同一节点同一位置的启用中自动变量（它属于更早的版本）。 */
async function inheritedVariable(tx: Tx, scope: MaterializeScope, nodeKey: string, slot: Slot, ids: string[]) {
  if (!ids.length) return undefined;
  const [row] = await tx
    .select(selection)
    .from(table)
    .where(
      and(
        eq(table.tenantId, scope.tenantId),
        inArray(table.id, ids),
        eq(table.origin, 'auto'),
        eq(table.originProcessId, scope.processId),
        eq(table.originNodeKey, nodeKey),
        eq(table.originSlot, slot),
        eq(table.status, 'enabled'),
        sql`${table.originVersionId} <> ${scope.versionId}::uuid`,
      ),
    )
    .limit(1);
  return row;
}

async function createAuto(
  tx: Tx,
  ctx: ApprovalContext,
  scope: MaterializeScope,
  node: ApprovalNode,
  slot: Slot,
  dataType: 'person' | 'persons',
  people: readonly string[] | null,
): Promise<VariableRow> {
  const name = autoVariableName(scope.processName, node.name, slot);
  if (textViolation(name, VARIABLE_TEXT_FIELDS.variableName))
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_AUTO_VARIABLE_NAME_INVALID', '无法由流程名与节点名生成合法的变量名称');
  const stem = autoVariableStem(scope.processCode);
  for (let step = 0; step < CODE_TRIES; step += 1) {
    const [row] = await tx
      .insert(table)
      .values({
        tenantId: ctx.tenantId,
        scope: 'public',
        appId: null,
        code: `Global.B.${stem}${ctx.now.getTime() + step}`,
        name,
        dataType,
        defaultValue: valueFor(dataType, people),
        usageScopes: ['process'],
        description: AUTO_DESCRIPTION,
        status: 'enabled',
        origin: 'auto',
        originProcessId: scope.processId,
        originVersionId: scope.versionId,
        originNodeKey: node.key,
        originSlot: slot,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      // 预定编码被占用（人工变量或同次保存先生成的）→ 顺延 1 毫秒，事务不中断
      .onConflictDoNothing({ target: [table.tenantId, table.code] })
      .returning(selection);
    if (!row) continue;
    await auditVariable(tx, ctx, 'auto_create', null, row);
    return row;
  }
  throw approvalError('CONFLICT', 'APPROVAL_AUTO_VARIABLE_CODE_EXHAUSTED', '自动变量编码冲突过多，请稍后重试');
}

async function changeAuto(
  tx: Tx,
  ctx: ApprovalContext,
  before: VariableRow,
  change: { defaultValue: unknown } | { status: 'disabled' },
  action: 'auto_update' | 'auto_disable',
  extra: Record<string, unknown>,
): Promise<VariableRow> {
  const [after] = await tx
    .update(table)
    .set({ ...change, revision: before.revision + 1, updatedBy: ctx.userId, updatedAt: ctx.now })
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.id, before.id)))
    .returning(selection);
  await auditVariable(tx, ctx, action, before, after!, extra);
  return after!;
}

// ───────── 保存：指定人员 → 公共变量 ─────────

const publicVariable = (id: string): ApproverSource => ({ type: 'public_variable', value: id });

interface SlotInput {
  node: ApprovalNode;
  slot: Slot;
  dataType: 'person' | 'persons';
  sources: readonly ApproverSource[];
  /** 保存前草稿里本位置的来源（继承变量与待生效值从这里找） */
  prior: readonly StoredSource[];
}

/** 一个位置内的全部“指定人员”（含未选人占位）合并成一条变量来源，放在第一个指定人员的位置上。 */
async function materializeSlot(tx: Tx, ctx: ApprovalContext, scope: MaterializeScope, input: SlotInput) {
  const { node, slot, dataType, sources, prior } = input;
  if (!sources.some((source) => source.type === 'specified')) return [...sources];
  const real = [...new Set(sources.filter((s) => s.type === 'specified' && !isUnselectedSpecified(s)).map((s) => canonicalId(s.value)))];
  const people = real.length ? real : null;
  const stored = await decide(tx, ctx, scope, input, people, dataType);
  const out: ApproverSource[] = [];
  let placed = false;
  for (const source of sources) {
    if (source.type !== 'specified') out.push(source);
    else if (!placed) {
      out.push(stored);
      placed = true;
    }
  }
  return out;
}

async function decide(
  tx: Tx,
  ctx: ApprovalContext,
  scope: MaterializeScope,
  input: SlotInput,
  people: readonly string[] | null,
  dataType: 'person' | 'persons',
): Promise<ApproverSource> {
  const { node, slot, prior } = input;
  const owned = await ownedVariable(tx, scope, node.key, slot);
  if (owned) {
    if (owned.dataType !== dataType) {
      await changeAuto(tx, ctx, owned, { status: 'disabled' }, 'auto_disable', { reason: '节点类型变化' });
      return publicVariable((await createAuto(tx, ctx, scope, node, slot, dataType, people)).id);
    }
    if (!sameSet(peopleOfRow(owned), people))
      await changeAuto(tx, ctx, owned, { defaultValue: valueFor(dataType, people) }, 'auto_update', {});
    return publicVariable(owned.id);
  }
  const priorIds = prior.filter((s) => s.type === 'public_variable').map((s) => s.value);
  const inherited = await inheritedVariable(tx, scope, node.key, slot, priorIds);
  if (!inherited || inherited.dataType !== dataType)
    return publicVariable((await createAuto(tx, ctx, scope, node, slot, dataType, people)).id);
  if (sameSet(peopleOfRow(inherited), people)) return publicVariable(inherited.id);
  // 继承自更早版本的变量：草稿里只记待生效值，发布时才写变量（DEC-861⑤）
  const earlier = prior.find((s) => s.type === 'public_variable' && s.value === inherited.id);
  const pending: StoredSource = {
    ...publicVariable(inherited.id),
    pendingUserIds: people ?? [],
    pendingRevision: earlier?.pendingRevision ?? inherited.revision,
  };
  return pending;
}

const slotSources = (node: ApprovalNode | undefined, slot: Slot): StoredSource[] => {
  if (!node) return [];
  if (slot === 'empty_approver') return [...(node.emptyApproverSources ?? [])];
  return isCountersign(node) ? [...node.approvers] : [node.approver];
};

/** 落成变量后的节点：approver / emptyApproverSources 里不再有 specified。 */
export async function materializeNode(
  tx: Tx,
  ctx: ApprovalContext,
  scope: MaterializeScope,
  node: ApprovalNode,
): Promise<ApprovalNode> {
  const before = scope.previous?.get(node.key);
  const common = { node, sources: [] as ApproverSource[] };
  let next: ApprovalNode = node;
  if (isCountersign(node)) {
    const approvers = await materializeSlot(tx, ctx, scope, {
      ...common,
      slot: 'approver',
      dataType: 'persons',
      sources: node.approvers,
      prior: slotSources(before, 'approver'),
    });
    next = { ...node, approvers };
  } else {
    const [approver] = await materializeSlot(tx, ctx, scope, {
      ...common,
      slot: 'approver',
      dataType: 'person',
      sources: [node.approver],
      prior: slotSources(before, 'approver'),
    });
    next = { ...node, approver: approver! };
  }
  if (node.emptyApproverSources?.length) {
    const emptyApproverSources = await materializeSlot(tx, ctx, scope, {
      ...common,
      slot: 'empty_approver',
      dataType: 'persons',
      sources: node.emptyApproverSources,
      prior: slotSources(before, 'empty_approver'),
    });
    next = { ...next, emptyApproverSources };
  }
  return next;
}

/** 落成变量后合并出的会签审批人重复（例如“指定人员”变量与同一继承变量并存）。 */
export function assertNoMergedDuplicate(node: ApprovalNode) {
  if (countersignDuplicate(node))
    throw approvalError('VALIDATION_FAILED', 'APPROVAL_DEFINITION_INVALID', `会签节点 ${node.key} 的审批人重复`);
}

// ───────── 保存收尾：不再被引用的自动变量停用 ─────────

const variableIdsOf = (nodes: Iterable<ApprovalNode>): string[] => {
  const ids = new Set<string>();
  for (const node of nodes) {
    for (const slot of ['approver', 'empty_approver'] as const)
      for (const source of slotSources(node, slot)) if (source.type === 'public_variable') ids.add(source.value);
  }
  return [...ids];
};

/**
 * 候选 = 保存前草稿引用过的自动变量 + 本版本自己归属的未停用自动变量；
 * 全部在用版本（草稿 / 当前 / 仍有可恢复实例的旧版本）都不再引用才停用（DEC-859）。
 */
export async function retireUnreferencedAutoVariables(
  tx: Tx,
  ctx: ApprovalContext,
  scope: MaterializeScope,
): Promise<void> {
  const referenced = variableIdsOf(scope.previous?.values() ?? []);
  const candidates = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.tenantId, ctx.tenantId),
        eq(table.origin, 'auto'),
        eq(table.status, 'enabled'),
        sql`(${table.originVersionId} = ${scope.versionId}::uuid ${
          referenced.length ? sql`OR ${inArray(table.id, referenced)}` : sql``
        })`,
      ),
    )
    .orderBy(table.id);
  for (const { id } of candidates) {
    const current = await loadVariable(tx, ctx.tenantId, id, true);
    if (current.status !== 'enabled') continue;
    if ((await findSourceUsages(tx, ctx.tenantId, { kind: 'variable', id })).length) continue;
    await changeAuto(tx, ctx, current, { status: 'disabled' }, 'auto_disable', { reason: RETIRE_REASON });
  }
}

// ───────── 发布：落地待生效值 ─────────

export interface PendingResolution {
  variableId: string;
  revision: number;
  choice: 'designer' | 'current';
}

interface PendingEntry {
  node: ApprovalNode;
  slot: Slot;
  index: number;
  source: StoredSource;
}

function pendingEntries(draft: VersionView): PendingEntry[] {
  const entries: PendingEntry[] = [];
  for (const node of draft.nodes) {
    for (const slot of ['approver', 'empty_approver'] as const) {
      slotSources(node, slot).forEach((source, index) => {
        if (source.type === 'public_variable' && source.pendingUserIds) entries.push({ node, slot, index, source });
      });
    }
  }
  return entries;
}

const stripPending = (source: ApproverSource): ApproverSource => ({ type: source.type, value: source.value });

/**
 * 发布草稿时把节点上的待生效人员写进继承变量（同一事务，操作人为发布人）；没有待生效值返回 null，否则返回清理后的节点：
 * 变量在草稿期间被管理员改过（版本号与记录时不同）→ 409，由发布人逐个选择“采用设计器值 / 保留变量页值”后重提。
 */
export async function applyPendingAutoVariables(
  tx: Tx,
  ctx: ApprovalContext,
  scope: MaterializeScope,
  draft: VersionView,
  resolutions: readonly PendingResolution[],
): Promise<ApprovalNode[] | null> {
  const entries = pendingEntries(draft);
  const known = new Set(entries.map((entry) => entry.source.value));
  for (const resolution of resolutions)
    if (!known.has(resolution.variableId))
      throw approvalError('VALIDATION_FAILED', 'APPROVAL_PENDING_RESOLUTION_INVALID', '处理项不对应任何待生效变量');
  if (!entries.length) return null;
  const replaced = new Map<string, string>();
  const conflicts: Record<string, unknown>[] = [];
  const writes: { entry: PendingEntry; row: VariableRow | null; people: string[] | null; resolution?: string }[] = [];
  for (const entry of [...entries].sort((a, b) => a.source.value.localeCompare(b.source.value))) {
    const row = await loadVariable(tx, ctx.tenantId, entry.source.value, true);
    const people = entry.source.pendingUserIds!.length ? [...entry.source.pendingUserIds!] : null;
    if (row.status === 'disabled') {
      writes.push({ entry, row: null, people });
      continue;
    }
    if (sameSet(peopleOfRow(row), people)) continue;
    if (row.revision === entry.source.pendingRevision) {
      writes.push({ entry, row, people });
      continue;
    }
    const chosen = resolutions.find((item) => item.variableId === row.id);
    if (chosen && chosen.revision !== row.revision)
      throw approvalError('CONFLICT', 'APPROVAL_PENDING_VARIABLE_CONFLICT', '变量已再次变化，请重新选择');
    if (!chosen)
      conflicts.push({
        variableId: row.id,
        code: row.code,
        name: row.name,
        nodeKey: entry.node.key,
        revision: row.revision,
        designerUserIds: people ?? [],
        currentUserIds: peopleOfRow(row) ?? [],
      });
    else if (chosen.choice === 'designer') writes.push({ entry, row, people, resolution: 'designer' });
  }
  if (conflicts.length)
    throw approvalError(
      'CONFLICT',
      'APPROVAL_PENDING_VARIABLE_CONFLICT',
      '公共变量在草稿期间已在变量页修改，请选择采用设计器值或保留变量页值后再发布',
      { conflicts },
    );
  const trigger = { kind: 'publish', versionId: draft.id };
  for (const { entry, row, people, resolution } of writes) {
    if (!row) {
      const created = await createAuto(
        tx,
        ctx,
        { ...scope, versionId: draft.id },
        entry.node,
        entry.slot,
        entry.slot === 'empty_approver' || isCountersign(entry.node) ? 'persons' : 'person',
        people,
      );
      replaced.set(entry.source.value, created.id);
      continue;
    }
    await changeAuto(tx, ctx, row, { defaultValue: valueFor(row.dataType, people) }, 'auto_update', {
      trigger,
      ...(resolution ? { resolution } : {}),
    });
  }
  // 节点表只允许增删不允许 UPDATE：返回去掉待生效键、换好新变量的节点，由发布流程整体重写
  const swap = (sources: readonly ApproverSource[]) =>
    sources.map((s) =>
      s.type === 'public_variable' && replaced.has(s.value) ? publicVariable(replaced.get(s.value)!) : stripPending(s),
    );
  return draft.nodes.map((node) => {
    const next: ApprovalNode = isCountersign(node)
      ? { ...node, approvers: swap(node.approvers) }
      : { ...node, approver: swap([node.approver])[0]! };
    return node.emptyApproverSources ? { ...next, emptyApproverSources: swap(node.emptyApproverSources) } : next;
  });
}

// ───────── 视图：回显自动变量与待生效值 ─────────

interface AutoViewRow {
  id: string;
  code: string;
  status: string;
  revision: number;
  data_type: string;
  default_text: string | null;
  origin_process_id: string;
  origin_node_key: string;
  origin_slot: string;
}

export interface AutoVariableView {
  id: string;
  code: string;
  status: string;
  revision: number;
  userIds: string[] | null;
  pendingUserIds?: string[];
  pendingConflict?: true;
}

/** 本流程节点位置上的自动变量在视图里回显；对外不暴露库内的待生效键，改用 autoVariable.pendingUserIds。 */
export async function enrichProcessView(tx: Tx, tenantId: string, view: ProcessView): Promise<ProcessView> {
  const versions = [view.latestVersion, ...(view.currentVersion && view.currentVersion !== view.latestVersion ? [view.currentVersion] : [])];
  const ids = [...new Set(variableIdsOf(versions.flatMap((v) => v.nodes)))];
  const rows = ids.length
    ? rowsOf<AutoViewRow>(
        await tx.execute(sql`SELECT id::text, code, status, revision, data_type, default_value::text AS default_text,
            origin_process_id::text, origin_node_key, origin_slot
          FROM approval_variables
          WHERE tenant_id=${tenantId}::uuid AND origin='auto' AND origin_process_id=${view.id}::uuid
            AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`),
      )
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const enrichSource = (node: ApprovalNode, slot: Slot) => (source: ApproverSource): ApproverSource => {
    const { pendingUserIds, pendingRevision, ...plain } = source as StoredSource;
    const row = source.type === 'public_variable' ? byId.get(source.value) : undefined;
    if (!row || row.origin_node_key !== node.key || row.origin_slot !== slot) return plain as ApproverSource;
    const value: unknown = row.default_text === null ? null : JSON.parse(row.default_text);
    const autoVariable: AutoVariableView = {
      id: row.id,
      code: row.code,
      status: row.status,
      revision: Number(row.revision),
      userIds: value === null ? null : Array.isArray(value) ? (value as string[]) : [value as string],
      ...(pendingUserIds ? { pendingUserIds: [...pendingUserIds] } : {}),
      ...(pendingUserIds && pendingRevision !== undefined && pendingRevision !== Number(row.revision)
        ? { pendingConflict: true as const }
        : {}),
    };
    return { ...plain, autoVariable } as ApproverSource;
  };
  const enrichNode = (node: ApprovalNode): ApprovalNode => {
    const approver = enrichSource(node, 'approver');
    const empty = enrichSource(node, 'empty_approver');
    const base: ApprovalNode = isCountersign(node)
      ? { ...node, approvers: node.approvers.map(approver) }
      : { ...node, approver: approver(node.approver) };
    return node.emptyApproverSources ? { ...base, emptyApproverSources: node.emptyApproverSources.map(empty) } : base;
  };
  const enrichVersion = (version: VersionView): VersionView => ({ ...version, nodes: version.nodes.map(enrichNode) });
  const latestVersion = enrichVersion(view.latestVersion);
  const currentVersion = !view.currentVersion
    ? null
    : view.currentVersion === view.latestVersion
      ? latestVersion
      : enrichVersion(view.currentVersion);
  return { ...view, latestVersion, currentVersion };
}
