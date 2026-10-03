/**
 * 流程匹配（DEC-017）：先按审批类型过滤，再按优先级评估发起条件；同类型都不满足即报错，不跨业务兜底。
 * 兜底流程（DEC-018）始终排在同类型条件流程之后，与其填写的优先级无关（DEC-096）；同类型普通流程优先级相同
 * 在发布时即被拒绝（DEC-096），按流程编码排序只作确定性兜底（D-005）。
 * originalSiteMatch 只用于仿真对照原站“按实体发起”的规则（`14` §8.6）。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  evaluateCondition,
  type ApprovalTypeCode,
  type ConditionContext,
  type ConditionResult,
  type ProcessCondition,
} from '@italent/domain';
import { rowsOf } from './context.js';
import { conditionItem } from './definitions.js';
import { adminAncestors } from './resolver.js';

export interface MatchVersion {
  readonly id: string;
  readonly versionNo: number;
  readonly status: 'draft' | 'published';
  readonly priority: number;
  readonly isFallback: boolean;
  readonly conditions: ProcessCondition;
}

export interface Candidate {
  readonly processId: string;
  readonly code: string;
  readonly approvalType: ApprovalTypeCode;
  readonly version: MatchVersion;
}

export interface Evaluated extends Candidate {
  readonly condition: ConditionResult;
}

/**
 * 某对象下全部可用流程的指定版本（已发布 = 当前生效版本；最新 = 最新版本，含草稿）。
 * DEC-101：不设流程数量硬上限，按编码分批读取，每条语句有界。
 */
export async function candidates(
  tx: Tx,
  tenantId: string,
  filter: { objectCode: string; approvalType?: ApprovalTypeCode; scope: 'published' | 'latest' },
): Promise<Candidate[]> {
  const result: Candidate[] = [];
  for (;;) {
    const batch = await candidateBatch(tx, tenantId, filter, result.at(-1)?.code ?? null);
    result.push(...batch);
    if (batch.length < BATCH) return result;
  }
}

const BATCH = 200;

async function candidateBatch(
  tx: Tx,
  tenantId: string,
  filter: { objectCode: string; approvalType?: ApprovalTypeCode; scope: 'published' | 'latest' },
  afterCode: string | null,
): Promise<Candidate[]> {
  const versionJoin =
    filter.scope === 'published'
      ? sql`v.id=p.current_version_id`
      : sql`v.process_id=p.id AND v.version_no=p.latest_version_no`;
  const rows = rowsOf(
    await tx.execute(sql`SELECT p.id,p.code,p.approval_type,v.id AS version_id,v.version_no,v.status,v.priority,
        v.is_fallback,v.condition_expression
      FROM approval_processes p JOIN approval_process_versions v ON v.tenant_id=p.tenant_id AND ${versionJoin}
      WHERE p.tenant_id=${tenantId} AND p.status='active' AND p.object_code=${filter.objectCode}
        ${filter.approvalType ? sql`AND p.approval_type=${filter.approvalType}` : sql``}
        ${afterCode === null ? sql`` : sql`AND p.code>${afterCode}`}
      ORDER BY p.code LIMIT ${BATCH}`),
  );
  if (!rows.length) return [];
  const ids = rows.map((row) => String(row.version_id));
  // 每个版本至多 50 个条件条目（definition-input），本批条件读取有界。
  const items = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_process_conditions WHERE tenant_id=${tenantId}
      AND version_id=ANY(${`{${ids.join(',')}}`}::uuid[]) ORDER BY version_id,item_no LIMIT ${BATCH * 50}`),
  );
  return rows.map((row) => ({
    processId: String(row.id),
    code: String(row.code),
    approvalType: row.approval_type as ApprovalTypeCode,
    version: {
      id: String(row.version_id),
      versionNo: Number(row.version_no),
      status: row.status as MatchVersion['status'],
      priority: Number(row.priority),
      isFallback: Boolean(row.is_fallback),
      conditions: {
        expression: String(row.condition_expression),
        items: items.filter((item) => item.version_id === row.version_id).map(conditionItem),
      },
    },
  }));
}

/** 条件中引用的组织取值 → 行政祖先链，供“包含下级”判断。 */
export async function conditionContext(
  tx: Tx,
  tenantId: string,
  asOf: string,
  approvalType: ApprovalTypeCode,
  values: Readonly<Record<string, unknown>>,
): Promise<ConditionContext> {
  const orgAncestors: Record<string, readonly string[]> = {};
  for (const field of APPROVAL_TYPES[approvalType].conditionFields) {
    const value = values[field.path];
    if (field.kind === 'org' && typeof value === 'string' && !orgAncestors[value]) {
      orgAncestors[value] = await adminAncestors(tx, tenantId, asOf, value);
    }
  }
  return { values, orgAncestors };
}

export function evaluate(list: readonly Candidate[], context: ConditionContext): Evaluated[] {
  return list.map((candidate) => ({
    ...candidate,
    condition: evaluateCondition(candidate.version.conditions, context),
  }));
}

const byCode = (a: Candidate, b: Candidate) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

export function replicaMatch(list: readonly Evaluated[], type: ApprovalTypeCode): Evaluated | null {
  const ordered = list
    .filter((item) => item.approvalType === type)
    .sort(
      (a, b) =>
        Number(a.version.isFallback) - Number(b.version.isFallback) ||
        a.version.priority - b.version.priority ||
        byCode(a, b),
    );
  return ordered.find((item) => item.condition.result) ?? null;
}

/** 原站按实体发起：不看审批类型，按排序号从小到大取第一条满足条件的流程（并列规则未取证，DEC-022 不追查）。 */
export function originalSiteMatch(list: readonly Evaluated[]): Evaluated | null {
  const ordered = [...list].sort((a, b) => a.version.priority - b.version.priority || byCode(a, b));
  return ordered.find((item) => item.condition.result) ?? null;
}

export function noProcessMessage(type: ApprovalTypeCode): string {
  return `没有可用的${APPROVAL_TYPES[type].name}流程`;
}
