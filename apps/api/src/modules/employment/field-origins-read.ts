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
 * 业务是否已落地（唯一事实函数，设计 §4.9 “尚未落地解析”）。“已落地” = 该业务曾在某个租户日期实际生效过：
 * 它的生效结果进入过时间轴，且那条条目的生效日已到。事后被摘下 / 重排 / 删除不改变“曾落地”这个事实；
 * 从未实际生效的（作废的未来调动、离职提前摘下的未来调动、撤回 / 驳回 / 未到点的申请）仍是“未落地”。
 * 同一只读快照里按三个只追加或可变投影上的事实判（不读载荷版本），任一成立即已落地（DEC-991 方案 B）：
 * 1. 时间轴上现有该业务的条目，且条目生效日 ≤ 租户今天；
 * 2. 摘除台账（exit_effects future_transfer_detached，只追加）记下的被摘窗口起点 ≤ 摘除当天的租户日期——
 *    摘下时它已经生效过（如同日落地、随后被退休顺延重排摘出）；窗口起点晚于摘除当天的是提前摘出，从未生效；
 * 3. 删除墓碑（只追加）记下的删除前时间轴生效日 ≤ 删除当天的租户日期——删除前它在轴上且已到期。
 *    被摘下后才删除的墓碑此列为空，不据此判，只看第 2 条；旧墓碑不回填（DEC-402）。
 * 已知限制（F-557）：挂回不留回执，`repositionExit` 同事务挂回再重摘会写新的摘除行。第 2 条可信的前提是
 * 离职摘除台账里未作废的目标摘下时都已生效，退休日期不可改（守卫见 AC-EMP-32 “离职改期先挂回再重摘”）。
 * 放开退休改期、或挂回目标可能是未生效调动之前，须按 F-557 升级到在场台账。
 */
export async function isBusinessLanded(tx: Tx, ctx: EmploymentContext, businessId: string): Promise<boolean> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const [row] = rowsOf<{ landed: boolean }>(
    await tx.execute(sql`SELECT (
      EXISTS (SELECT 1 FROM employment_timeline
        WHERE tenant_id = ${ctx.tenantId}::uuid AND record_id = ${businessId}::uuid AND start_date <= ${today}::date)
      OR EXISTS (SELECT 1 FROM exit_effects x
        WHERE x.tenant_id = ${ctx.tenantId}::uuid AND x.target_id = ${businessId}::uuid
          AND x.kind = 'future_transfer_detached' AND x.phase = 'effective' AND x.target_type = 'employment-record'
          AND (x.detail -> 'window' ->> 'from')::date <= (x.created_at AT TIME ZONE ${ctx.timezone})::date)
      OR EXISTS (SELECT 1 FROM employment_record_tombstones t
        WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.record_id = ${businessId}::uuid
          AND t.timeline_start_date <= (t.created_at AT TIME ZONE ${ctx.timezone})::date)
    ) AS landed`),
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
      // 业务已落地（曾实际生效，见 isBusinessLanded）的延迟字段不再待解析；resolved 写入归 S6，本片不写
      pending: state?.policy === 'deferred' && writer === null && !facts.landed,
      suspended: (state?.suspended.size ?? 0) > 0,
    };
  });
}
