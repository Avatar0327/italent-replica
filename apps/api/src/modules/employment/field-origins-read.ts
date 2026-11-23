/**
 * 字段来源只读接口的出数（F-036 设计 §4.9）：把详情路由算出的 `shown` 与来源台账折叠结果拼成行。
 * 字段集合与值只取自 `shown`（不另开读数据的通道）；来源只是附在其上的说明。
 */
import { sql, type Tx } from '@italent/db';
import { effectiveOrigin, tenantLocalDate, type FieldOriginKind } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import { loadFieldOrigins } from './field-origin-store.js';
import { sourceReadable } from './read-decision.js';
import { rowsOf } from './read-model.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';

export interface FieldOriginView {
  readonly kind: FieldOriginKind;
  readonly label: string | null;
  readonly at: string;
  readonly sourceBusinessId: string | null;
  readonly reason: string | null;
}

export interface FieldOriginRowView {
  readonly fieldCode: string;
  readonly value: unknown;
  readonly origin: FieldOriginView | null;
  readonly policy: string | null;
  readonly pending: boolean;
  readonly suspended: boolean;
}

/** 展示名：取设计 §4.2 “来源种类”列；策略行 none / retain 与判定行 fallback / restore 不单独展示。 */
const ORIGIN_LABELS: Readonly<Record<FieldOriginKind, string | null>> = {
  inherit: '继承',
  deferred: '延迟继承',
  resolved: '延迟继承（落地）',
  copy: 'HR / 系统保存',
  'hr-input': 'HR / 系统保存',
  'system-input': 'HR / 系统保存',
  'employee-input': '员工本次输入',
  'approval-edit': '审批节点编辑',
  'hr-record': 'HR 补录',
  'forward-update': '向后更新',
  derive: '向后更新（引用派生）',
  'derive-edit': '向后更新（引用派生）',
  'sequence-sync': '序列同步',
  'status-propagate': '状态传播',
  none: null,
  retain: null,
  fallback: null,
  restore: null,
};

type Shown = {
  readonly fields?: Record<string, unknown>;
  readonly customFields?: Record<string, unknown>;
  readonly employeeStatus?: unknown;
  readonly entryStatus?: unknown;
};

/** `shown` 里出现的字段：预置 `preset:<名>`、自定义 `custom:<ID>`、状态 `status:<名>`。 */
function shownEntries(shown: Shown) {
  const entries: { fieldCode: string; value: unknown }[] = [];
  for (const [name, value] of Object.entries(shown.fields ?? {})) entries.push({ fieldCode: `preset:${name}`, value });
  for (const [id, value] of Object.entries(shown.customFields ?? {}))
    entries.push({ fieldCode: `custom:${id}`, value });
  for (const name of ['employeeStatus', 'entryStatus'] as const)
    if (name in shown) entries.push({ fieldCode: `status:${name}`, value: shown[name] });
  return entries;
}

/** 冻结分支：已办审批人读办理当时的内容，不读来源台账，不带任何现值信息。 */
export function frozenOriginRows(shown: Shown): FieldOriginRowView[] {
  return shownEntries(shown).map((entry) => ({
    ...entry,
    origin: null,
    policy: null,
    pending: false,
    suspended: false,
  }));
}

type OriginStates = Awaited<ReturnType<typeof loadFieldOrigins>>;

export interface OriginFacts {
  readonly states: OriginStates;
  /** `isBusinessLanded` 的结果：本接口判断“业务是否已落地”的唯一事实。 */
  readonly landed: boolean;
}

/**
 * 业务是否已落地（唯一事实函数，设计 §4.9 “尚未落地解析”）：同一快照里，时间轴上有该业务的有效条目，
 * 且条目的实际生效日已到（租户时区）。不看任职记录行是否存在、不看载荷版本：
 * - 直接业务保存时就写记录行，但生效日前仍随前驱变化；离职作废的未来调动保留记录行，却已被摘出时间轴、永远不会落地；
 * - 申请批准后没有记录行也没有时间轴条目，由调度 / 审批落地时才一起写入，迟到顺延的实际生效日以条目为准。
 */
export async function isBusinessLanded(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<boolean> {
  const [row] = rowsOf<{ landed: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM employment_timeline
      WHERE tenant_id = ${ctx.tenantId}::uuid AND record_id = ${businessId}::uuid
        AND start_date <= ${tenantLocalDate(ctx.now, ctx.timezone)}::date) AS landed`),
  );
  return row?.landed === true;
}

/** 来源台账与落地事实：在 `decideEmploymentRead` 的值所在快照里读（并发写入不会让旧值配上新来源或新事实）。冻结分支不读。 */
export async function loadOriginFacts(
  tx: Tx,
  ctx: EmploymentContext,
  value: EmploymentBusiness,
  frozen: boolean,
): Promise<OriginFacts> {
  if (frozen) return { states: new Map() as OriginStates, landed: false };
  return { states: await loadFieldOrigins(tx, ctx, value.id), landed: await isBusinessLanded(tx, ctx, value.id) };
}

/** 来源业务 ID：逐个走与直接读来源单相同的读取决定（`sourceReadable`），不可读只清 ID。 */
async function readableSources(deps: TenantRouteDeps, entry: EmploymentContext, ids: readonly string[], asOf: string) {
  const readable = new Set<string>();
  for (const id of ids) if (await sourceReadable(deps, entry, id, asOf)) readable.add(id);
  return readable;
}

/** 现值分支：`entry` 是入口授权上下文（不是过了调动门禁的那份）；用快照里折叠好的台账状态给 `shown` 的每个字段附来源。只读，不写任何表。 */
export async function liveOriginRows(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  facts: OriginFacts,
  asOf: string,
  shown: Shown,
): Promise<FieldOriginRowView[]> {
  const entries = shownEntries(shown);
  const writers = new Map(
    entries.map((entry) => [entry.fieldCode, effectiveOrigin(facts.states.get(entry.fieldCode)).lastWriter]),
  );
  const sourceIds = [
    ...new Set([...writers.values()].flatMap((row) => (row?.sourceBusinessId ? [row.sourceBusinessId] : []))),
  ];
  const readable = sourceIds.length ? await readableSources(deps, entry, sourceIds, asOf) : new Set<string>();
  return entries.map((entry) => {
    const state = facts.states.get(entry.fieldCode);
    const writer = writers.get(entry.fieldCode) ?? null;
    return {
      ...entry,
      origin: writer && {
        kind: writer.originKind,
        label: ORIGIN_LABELS[writer.originKind],
        at: writer.createdAt.toISOString(),
        sourceBusinessId:
          writer.sourceBusinessId && readable.has(writer.sourceBusinessId) ? writer.sourceBusinessId : null,
        reason: writer.reason,
      },
      policy: state?.policy ?? null,
      // 业务已落地的延迟字段不再待解析（以时间轴上的有效条目为准）；resolved 写入归 S6，本片不写
      pending: state?.policy === 'deferred' && writer === null && !facts.landed,
      suspended: (state?.suspended.size ?? 0) > 0,
    };
  });
}
