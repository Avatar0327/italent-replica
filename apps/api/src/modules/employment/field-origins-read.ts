/**
 * 字段来源只读接口的出数（F-036 设计 §4.9）：把详情路由算出的 `shown` 与来源台账折叠结果拼成行。
 * 字段集合与值只取自 `shown`（不另开读数据的通道）；来源只是附在其上的说明。
 */
import { sql, type Tx } from '@italent/db';
import { effectiveOrigin, type FieldOriginKind } from '@italent/domain';
import type { ModuleScope } from '../permission/module-access.js';
import { loadFieldOrigins } from './field-origin-store.js';
import { rowsOf } from './read-model.js';
import { visibleEmploymentRecords } from './visibility.js';

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

/** 来源业务对操作人可见才给出 ID：取来源业务最新载荷的员工与部门，批量一次判定。 */
async function visibleSources(tx: Tx, tenantId: string, scope: ModuleScope | undefined, ids: readonly string[]) {
  if (!ids.length) return new Set<string>();
  const found = rowsOf<{ business_id: string; employee_id: string; department_id: string | null }>(
    await tx.execute(sql`
      SELECT DISTINCT ON (business_id) business_id, employee_id, department_id
      FROM employment_payload_versions
      WHERE tenant_id = ${tenantId}::uuid AND business_id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      ORDER BY business_id, version_no DESC`),
  );
  const visible = await visibleEmploymentRecords(
    tx,
    tenantId,
    scope,
    found.map((row) => ({ employeeId: row.employee_id, departmentId: row.department_id })),
  );
  return new Set(found.filter((_, index) => visible[index]).map((row) => row.business_id));
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

/** 现值分支：读台账折叠状态，给 `shown` 里的每个字段附来源。只读，不写任何表。 */
export async function liveOriginRows(
  tx: Tx,
  ctx: { readonly tenantId: string; readonly scope?: ModuleScope | undefined },
  businessId: string,
  shown: Shown,
): Promise<FieldOriginRowView[]> {
  const entries = shownEntries(shown);
  const states = await loadFieldOrigins(
    tx,
    ctx,
    businessId,
    entries.map((entry) => entry.fieldCode),
  );
  const writers = new Map(
    entries.map((entry) => [entry.fieldCode, effectiveOrigin(states.get(entry.fieldCode)).lastWriter]),
  );
  const sourceIds = [
    ...new Set([...writers.values()].flatMap((row) => (row?.sourceBusinessId ? [row.sourceBusinessId] : []))),
  ];
  const visible = await visibleSources(tx, ctx.tenantId, ctx.scope, sourceIds);
  return entries.map((entry) => {
    const state = states.get(entry.fieldCode);
    const writer = writers.get(entry.fieldCode) ?? null;
    return {
      ...entry,
      origin: writer && {
        kind: writer.originKind,
        label: ORIGIN_LABELS[writer.originKind],
        at: writer.createdAt.toISOString(),
        sourceBusinessId:
          writer.sourceBusinessId && visible.has(writer.sourceBusinessId) ? writer.sourceBusinessId : null,
        reason: writer.reason,
      },
      policy: state?.policy ?? null,
      pending: state?.policy === 'deferred' && writer === null,
      suspended: (state?.suspended.size ?? 0) > 0,
    };
  });
}
