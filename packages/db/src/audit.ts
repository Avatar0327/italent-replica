/**
 * 统一审计写入（R1-T16；DEC-019；docs/02_业务建模/20 §5；AGENTS.md §10「审计」）。
 * 各模块（含平台命令在租户内的写入）都经这里写 audit_events：在调用方的租户事务内写入，与业务同提交、同回滚；
 * 操作类型与字段级差异在写入时算出，引用字段（部门、职位、经理等）按同一事务里当时的名称冻结显示值。
 * 对象操作日志（批量 / 导入 / 导出 / 下载）与失败命令审计另有两张表，见 schema/audit.ts。
 */
import {
  AUDIT_REFERENCE_KINDS,
  type AuditBehavior,
  type AuditFieldChange,
  type AuditReferenceKind,
  auditOperationOf,
  auditReferenceKind,
  auditTaskSummary,
  type CommandFailureOutcome,
  diffAuditFields,
  renderAuditValue,
} from '@italent/domain';
import { sql } from 'drizzle-orm';
import { auditCommandFailures, auditEvents, auditOperationLogs } from './schema/index.js';
import { isUuid, type Tx } from './tenant-context.js';

/** 请求来源（20 §2）；系统任务没有请求，来源动作记“定时任务”。 */
export interface AuditSource {
  readonly sourceAction?: string | null;
  readonly sourcePageType?: string | null;
  readonly sourcePage?: string | null;
  readonly terminal?: string | null;
  readonly clientVersion?: string | null;
  readonly ip?: string | null;
  readonly traceId?: string | null;
}

export interface AuditEventInput {
  readonly tenantId: string;
  /** 系统任务为空，显示为“系统”。 */
  readonly actorUserId: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly commandId?: string | null;
  readonly occurredAt?: Date;
  readonly source?: AuditSource;
  /** DEC-197 归属：写入方确知时显式给出（如人员子集记录的所属人员）；未给的由迁移 0057 的触发器按对象类型推导。 */
  readonly scope?: { readonly employeeId?: string | null; readonly orgId?: string | null };
}

export const SCHEDULED_SOURCE_ACTION = '定时任务';

export async function insertAuditEvent(tx: Tx, entry: AuditEventInput): Promise<void> {
  const operation = auditOperationOf(entry.action, entry.before, entry.after);
  const occurredAt = entry.occurredAt ?? new Date();
  const changes = await resolveReferences(tx, entry.tenantId, occurredAt, diffAuditFields(entry.before, entry.after));
  await tx.insert(auditEvents).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    objectType: entry.objectType,
    objectId: entry.objectId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    commandId: entry.commandId ?? null,
    occurredAt,
    operation,
    changes,
    ...sourceValues(entry.source, entry.actorUserId),
    scopeEmployeeId: entry.scope?.employeeId ?? null,
    scopeOrgId: entry.scope?.orgId ?? null,
  });
}

/**
 * 集合 SQL 直接写 audit_events 时（如人员序码重算，一条语句写多行），来源列取同一请求上下文；操作类型、字段差异、
 * 归属与“定时任务”来源由迁移 0057 的触发器按统一规则补齐（PR #75 第二轮 P2-6）。返回列清单与值，按此顺序拼接。
 */
export function auditSourceSql(source: AuditSource | undefined) {
  const values = sourceValues(source, source ? 'request' : null);
  return {
    columns: sql`source_action,source_page_type,source_page,terminal,client_version,ip,trace_id`,
    values: sql`${values.sourceAction},${values.sourcePageType},${values.sourcePage},${values.terminal},
      ${values.clientVersion},${values.ip},${values.traceId}`,
  };
}

export interface OperationLogInput {
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly behavior: AuditBehavior;
  readonly objectType: string;
  readonly objectId?: string | null;
  readonly successCount: number;
  readonly failureCount: number;
  /** 缺省按原站文案生成（「52条全部更新成功」）。 */
  readonly summary?: string;
  readonly errorReport?: unknown;
  readonly attachment?: unknown;
  readonly commandId?: string | null;
  readonly occurredAt?: Date;
  readonly source?: AuditSource;
  /** 任务针对某个人员时（如单人任职导入）显式给出所属人员，供 DEC-197 范围裁剪。 */
  readonly scopeEmployeeId?: string | null;
  /**
   * 跨人员 / 组织的任务逐行归属（PR #75 第三轮 P1-2）：每行的结果与所属人员 / 组织 / 对象编号，不含字段值。
   * 查询按查看人当前范围逐行判断，汇总与错误报告只按可见行计算。
   */
  readonly items?: readonly OperationLogItem[];
}

export interface OperationLogItem {
  readonly rowIndex: number;
  readonly outcome: 'succeeded' | 'failed';
  readonly objectId?: string | null;
  readonly employeeId?: string | null;
  readonly orgId?: string | null;
}

export async function insertOperationLog(tx: Tx, entry: OperationLogInput): Promise<void> {
  const counts = { success: entry.successCount, failure: entry.failureCount };
  const task = auditTaskSummary(entry.behavior, counts);
  await tx.insert(auditOperationLogs).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    behavior: entry.behavior,
    objectType: entry.objectType,
    objectId: entry.objectId ?? null,
    summary: entry.summary ?? task.summary,
    totalCount: counts.success + counts.failure,
    successCount: counts.success,
    failureCount: counts.failure,
    result: task.result,
    errorReport: entry.errorReport ?? null,
    attachment: entry.attachment ?? null,
    commandId: entry.commandId ?? null,
    ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
    ...sourceValues(entry.source, entry.actorUserId),
    scopeEmployeeId: entry.scopeEmployeeId ?? null,
    items: entry.items?.length ? entry.items.map(normalizeItem) : null,
  });
}

function normalizeItem(item: OperationLogItem) {
  const id = (value: string | null | undefined) => (value && isUuid(value) ? value.toLowerCase() : null);
  return {
    rowIndex: item.rowIndex,
    outcome: item.outcome,
    objectId: item.objectId ? (isUuid(item.objectId) ? item.objectId.toLowerCase() : item.objectId) : null,
    employeeId: id(item.employeeId),
    orgId: id(item.orgId),
  };
}

export interface CommandFailureInput {
  /** 预先生成的事件编号：写库失败转兜底通道时沿用，便于去重（PR #75 第二轮 P3）。 */
  readonly id?: string;
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly commandId: string;
  readonly outcome: CommandFailureOutcome;
  readonly errorCode: string;
  readonly reason?: string | null;
  readonly method?: string | null;
  readonly path?: string | null;
  readonly occurredAt?: Date;
  readonly source?: AuditSource;
}

export async function insertCommandFailure(tx: Tx, entry: CommandFailureInput): Promise<void> {
  await tx.insert(auditCommandFailures).values({
    ...(entry.id ? { id: entry.id } : {}),
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    commandId: entry.commandId,
    outcome: entry.outcome,
    errorCode: entry.errorCode,
    reason: entry.reason ?? null,
    method: entry.method ?? null,
    path: entry.path ?? null,
    ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
    ...sourceValues(entry.source, entry.actorUserId),
  });
}

function sourceValues(source: AuditSource | undefined, actorUserId: string | null | undefined) {
  // 没有请求上下文的系统写入（定时生效、合同定时任务、日志清理）来源动作记“定时任务”（20 §2、AC-AUD-04）
  const scheduled = !source && actorUserId === null;
  return {
    sourceAction: source?.sourceAction ?? (scheduled ? SCHEDULED_SOURCE_ACTION : null),
    sourcePageType: source?.sourcePageType ?? null,
    sourcePage: source?.sourcePage ?? null,
    terminal: source?.terminal ?? null,
    clientVersion: source?.clientVersion ?? null,
    ip: source?.ip ?? null,
    traceId: source?.traceId ?? null,
  };
}

/**
 * 引用字段的显示名：组织取当时有效（或最近一段）的名称，职务体系对象同理，人员取姓名。
 * 只读取本租户（RLS + 显式租户条件）；查不到的保留编号原值，不编造名称。
 */
const REFERENCE_SOURCES: Readonly<Record<AuditReferenceKind, { table: string; key: string; dated: boolean }>> = {
  org: { table: 'org_versions', key: 'org_id', dated: true },
  position: { table: 'job_position_versions', key: 'object_id', dated: true },
  post: { table: 'job_post_versions', key: 'object_id', dated: true },
  level: { table: 'job_level_versions', key: 'object_id', dated: true },
  grade: { table: 'job_grade_versions', key: 'object_id', dated: true },
  sequence: { table: 'job_sequence_versions', key: 'object_id', dated: true },
  professionalLine: { table: 'job_professional_line_versions', key: 'object_id', dated: true },
  employee: { table: 'employment_employees', key: 'id', dated: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveReferences(
  tx: Tx,
  tenantId: string,
  occurredAt: Date,
  changes: readonly AuditFieldChange[],
): Promise<AuditFieldChange[]> {
  const wanted = new Map<AuditReferenceKind, Set<string>>();
  const kindOf = (field: string) => auditReferenceKind(field.split('.').at(-1) ?? field);
  for (const change of changes) {
    const kind = kindOf(change.field);
    if (!kind) continue;
    for (const value of [change.from, change.to]) {
      if (typeof value === 'string' && UUID.test(value)) {
        wanted.set(kind, (wanted.get(kind) ?? new Set()).add(value.toLowerCase()));
      }
    }
  }
  const names = new Map<string, string>();
  for (const kind of AUDIT_REFERENCE_KINDS) {
    const ids = wanted.get(kind);
    if (!ids?.size) continue;
    for (const [id, name] of await referenceNames(tx, tenantId, occurredAt, kind, [...ids])) {
      names.set(`${kind}:${id}`, name);
    }
  }
  return changes.map((change) => {
    const kind = kindOf(change.field);
    if (!kind) return change;
    const text = (value: unknown) =>
      typeof value === 'string' ? (names.get(`${kind}:${value.toLowerCase()}`) ?? renderAuditValue(value)) : undefined;
    const fromText = text(change.from);
    const toText = text(change.to);
    return { ...change, ...(fromText === undefined ? {} : { fromText }), ...(toText === undefined ? {} : { toText }) };
  });
}

/**
 * 有效版本与各模块读取口径一致（P2-5）：业务日期取审计时点在租户时区的日期，生效日不晚于该日的版本中
 * 生效日最新、同日 version_no 最大者；对象在该日尚未生效时取最早的版本。
 */
async function referenceNames(
  tx: Tx,
  tenantId: string,
  occurredAt: Date,
  kind: AuditReferenceKind,
  ids: readonly string[],
): Promise<[string, string][]> {
  const source = REFERENCE_SOURCES[kind];
  const table = sql.identifier(source.table);
  const key = sql.identifier(source.key);
  const list = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;
  const day = sql`(${occurredAt.toISOString()}::timestamptz AT TIME ZONE current_tenant_timezone())::date`;
  const result = source.dated
    ? await tx.execute(sql`SELECT DISTINCT ON (${key}) ${key}::text AS id, name FROM ${table}
        WHERE tenant_id = ${tenantId} AND ${key} = ANY(${list})
        ORDER BY ${key}, (start_date <= ${day}) DESC,
          CASE WHEN start_date <= ${day} THEN start_date END DESC NULLS LAST, start_date, version_no DESC`)
    : await tx.execute(sql`SELECT ${key}::text AS id, name FROM ${table}
        WHERE tenant_id = ${tenantId} AND ${key} = ANY(${list})`);
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as {
    id: string;
    name: string;
  }[];
  return rows.map((row) => [row.id, row.name]);
}
