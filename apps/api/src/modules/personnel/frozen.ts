/**
 * 员工子集变更申请详情的冻结读（F-476 P5，docs/08_设计/F-476_审批办理时冻结快照_设计.md §5.4）。
 * 办理份 ext = { request, currentValues, originals }：申请行、办理时生效的载荷（含同单修正后的版本）、
 * 申请所针对的那一版子集记录上的原值（固定 targetRevision，之后源记录被改 / 被删都不漂移，设计清单 9）。
 */
import { sql, type Tx } from '@italent/db';
import { SUBSETS, type SubsetKind } from '@italent/domain';
import { pickDisclosed } from '../approval/frozen-read.js';
import { currentChangeValues, loadChange } from './change-requests.js';
import { camel, rows, type PersonnelContext, type Row } from './store.js';

export interface PersonnelContent {
  readonly request: Row;
  readonly currentValues: Row;
  /** 针对既有记录的申请：目标版本上同键的原值；新增记录为 null。 */
  readonly originals: Row | null;
}

/** 子集历史版本（含已删除记录的版本链），按记录 ID 与 revision 定位。 */
export async function subsetVersion(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  subset: SubsetKind,
  recordId: string,
  revision: number,
): Promise<Row | null> {
  const [raw] = rows(
    await tx.execute(sql`SELECT * FROM ${sql.identifier(`${SUBSETS[subset].table}_versions`)}
      WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid AND record_id=${recordId}::uuid
        AND revision=${revision} LIMIT 1`),
  );
  return raw ? camel(raw) : null;
}

/** 申请载荷对应的原值（清单 9：取 targetRevision 那一版，不取源记录现值）。 */
export async function changeOriginals(
  tx: Tx,
  tenantId: string,
  change: Row,
  subset: SubsetKind,
  values: Row,
): Promise<Row | null> {
  if (!change.recordId) return null;
  const record = await subsetVersion(
    tx,
    tenantId,
    String(change.employeeId),
    subset,
    String(change.recordId),
    Number(change.targetRevision),
  );
  return record ? Object.fromEntries(Object.keys(values).map((key) => [key, record[key] ?? null])) : null;
}

/** 办理份 provider，同时是申请详情读现值的来源。 */
export async function loadPersonnelContent(tx: Tx, tenantId: string, id: string): Promise<PersonnelContent> {
  const ctx = { tenantId } as PersonnelContext;
  const request = await loadChange(tx, ctx, id);
  const currentValues = await currentChangeValues(tx, ctx, id);
  const originals = await changeOriginals(tx, tenantId, request, String(request.subset) as SubsetKind, currentValues);
  return { request, currentValues, originals };
}

/**
 * 申请详情响应的容器投影契约（F-476 P5 R1 P2-2）：`values`（申请行上最初提交的载荷）、`currentValues`（办理 / 现时载荷）、
 * `originals`（原值）三个容器键不在申请对象的字段目录里，不能按申请对象的顶层字段权裁掉整个容器；
 * 改为在容器内部按子集字段披露集逐键裁（`nested`：已办 = 上限 ∩ 节点表单 ∩ 当前字段权，本人读现值 = 子集对象当前字段权）。
 * `originals` 另受「审批原值显示」开关控制，关闭时整个键不出现。申请自身的元数据（状态、修订号等）由路由按申请对象字段权裁。
 */
export function personnelContainers(
  content: PersonnelContent,
  nested: ReadonlySet<string> | undefined,
  showOriginals: boolean,
): Row {
  return {
    values: pickDisclosed(content.request.values as Row, nested),
    currentValues: pickDisclosed(content.currentValues, nested),
    ...(showOriginals ? { originals: content.originals && pickDisclosed(content.originals, nested) } : {}),
  };
}

/** 申请元数据：去掉容器键（容器走 personnelContainers），其余交路由按申请对象字段权裁。 */
export function personnelMetadata(content: PersonnelContent): Row {
  const { values: _values, ...metadata } = content.request;
  return metadata;
}
