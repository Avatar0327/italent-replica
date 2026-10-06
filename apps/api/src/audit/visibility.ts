/**
 * DEC-197 / DEC-203（PR #75 第二、三轮）：审计查询按查看人**当前**的数据范围与字段权限裁剪，不设全量读取特权。
 * 「日志审计」能力只决定能不能进入查询；每条日志能否返回，按它的对象类型复用**该业务对象自己的查看规则**：
 * - 每种写入审计的对象类型都在下方逐个登记（RULES / 配置对象），未登记的对象类型一律不返回（fail-closed）；
 * - 业务对象先要有该对象的查看权限（与业务接口 objectContext 同一 object.view），再按业务列表 / 详情的同一 SQL 谓词
 *   判断范围：任职 DEC-177、人员与合同按所属人员、组织 / 编制 / 职位按所属组织、全局职务体系对象与编制方案只认
 *   看全部或“使用用户（创建人）”、编制复制任务 / 通知 / 占编按其业务规则、组织编码预占只认看全部、审批实例按
 *   审批管理员按钮与任职 / 合同范围；
 * - 需要归属的对象推导不出所属人员 / 组织时不返回（第三轮 P1-1：“推导失败”不等于“无归属”）；
 * - “使用用户”维度按保留的创建人元数据（DEC-198，audit_object_creators）或模块真实的创建人列判断（第三轮 P2-1）；
 * - 真正的配置对象（DEC-203）持日志审计即可见；
 * - 跨人员 / 组织的任务日志按逐行归属判断（第三轮 P1-2）：至少一行可见才返回，汇总与错误报告只按可见行计算。
 * 行级判断全部在 SQL 里、分页之前完成；字段按该对象当前查看字段裁剪，至少一个可见字段变化的日志才返回。
 */
import { sql, type Tx, withTenant } from '@italent/db';
import {
  APPROVAL_INSTANCE_OBJECT,
  AUDIT_CONFIG_ACTIONS,
  AUDIT_CONFIG_OBJECT_TYPES,
  auditFieldCode,
  type AuditFieldChange,
  CONTRACT_OBJECT,
  ESTABLISHMENT_SCHEME_DATASOURCE,
  MODULE_OBJECTS,
  PERSONNEL_OBJECT,
  PERSONNEL_REQUEST_OBJECT,
  SUBSETS,
} from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import { adminScope } from '../modules/approval/access.js';
import { employmentCreator } from '../modules/employment/context.js';
import { employmentVisibilitySql } from '../modules/employment/visibility.js';
import {
  getModuleViewableFields,
  type ModuleScope,
  resolveModuleScope,
  scopeSql,
} from '../modules/permission/module-access.js';
import { JOB_OBJECT_CODES } from '../modules/permission/module-route-access.js';
import { creatorSql } from '../modules/permission/scope-audit.js';

/** 一条日志（或任务的一行）在规则里可用的列：对象编号（text）、所属人员 / 组织（uuid）、写入后的值（jsonb）。 */
interface Row {
  readonly objectId: SQL;
  readonly employee: SQL;
  readonly org: SQL;
  readonly after: SQL;
}

interface Viewer {
  readonly tenantId: string;
  readonly userId: string;
}

interface Rule {
  readonly types: readonly string[];
  /** 权限对象：查看权限、数据范围与字段权限都按它解析。 */
  readonly objectCode: string;
  /** 同一对象下需要单独授“看全部”的数据集（编制方案，DEC-121）。 */
  readonly view?: string;
  /** 字段权限不适用（审批实例日志按审批管理员视角整条展示）。 */
  readonly untrimmed?: boolean;
  readonly visible: (scope: ModuleScope, row: Row, viewer: Viewer, extra: SQL | null) => SQL;
  /** 规则需要的额外谓词（如审批管理员范围，对 approval_instances 别名 i）；返回 null 表示没有权限。 */
  readonly resolve?: (deps: Deps, ctx: TenantContext) => Promise<SQL | null>;
}

type Deps = TenantRouteDeps;

const ORG = MODULE_OBJECTS.organization.code;
const ESTABLISHMENT = MODULE_OBJECTS.establishment.code;
const EMPLOYMENT = MODULE_OBJECTS.employmentRecord.code;
const GLOBAL_JOB_KINDS = [
  'layers',
  'grades',
  'level-types',
  'levels',
  'sequences',
  'professional-lines',
  'posts',
] as const;

const uuidOf = (text: SQL) => sql`(CASE WHEN audit_is_uuid(${text}) THEN (${text})::uuid END)`;
/** 需要归属的对象：看全部照常可见；否则归属为空（推导失败）一律不可见。 */
const anchored = (scope: ModuleScope, anchor: SQL, predicate: SQL) =>
  scope.all ? sql`true` : sql`(${anchor} IS NOT NULL AND ${predicate})`;
const seeAllOnly = (scope: ModuleScope) => (scope.all ? sql`true` : sql`false`);
/** 职务体系的逐行回执以“命令:行号”为对象编号，回执里的 objectId 才是职务对象。 */
const jobObject = (row: Row) => sql`COALESCE(NULLIF(${row.after}->>'objectId', ''), ${row.objectId})`;

function personRule(types: readonly string[], objectCode: string, creator: (row: Row, viewer: Viewer) => SQL): Rule {
  return {
    types,
    objectCode,
    visible: (scope, row, viewer) =>
      anchored(scope, row.employee, scopeSql(scope, { person: row.employee, creator: creator(row, viewer) })),
  };
}

function orgRule(types: readonly string[], objectCode: string, creator: (row: Row, viewer: Viewer) => SQL): Rule {
  return {
    types,
    objectCode,
    visible: (scope, row, viewer) =>
      anchored(scope, row.org, scopeSql(scope, { org: row.org, creator: creator(row, viewer) })),
  };
}

const RULES: readonly Rule[] = [
  {
    types: ['employment-record', 'employment-business', 'transfer-request', 'employment_assignment'],
    objectCode: EMPLOYMENT,
    visible: (scope, row, viewer) =>
      anchored(
        scope,
        row.employee,
        employmentVisibilitySql(scope, {
          employee: row.employee,
          department: row.org,
          creator: employmentCreator(viewer.tenantId, row.objectId, true),
        }),
      ),
  },
  personRule(['employment_employee'], 'TenantBase.Employee', (row, viewer) =>
    employmentCreator(viewer.tenantId, row.employee),
  ),
  personRule([PERSONNEL_OBJECT, 'personnel-order-code'], PERSONNEL_OBJECT, (row, viewer) =>
    employmentCreator(viewer.tenantId, row.employee),
  ),
  ...Object.values(SUBSETS).map((subset) =>
    personRule([subset.objectCode], subset.objectCode, (row, viewer) => {
      const table = sql.identifier(subset.table);
      return sql`(SELECT s.created_by FROM ${table} s WHERE s.tenant_id = ${viewer.tenantId}
        AND s.id = ${uuidOf(row.objectId)})`;
    }),
  ),
  personRule([PERSONNEL_REQUEST_OBJECT], PERSONNEL_REQUEST_OBJECT, (row, viewer) => {
    return sql`(SELECT r.created_by FROM personnel_change_requests r WHERE r.tenant_id = ${viewer.tenantId}
      AND r.id = ${uuidOf(row.objectId)})`;
  }),
  personRule([CONTRACT_OBJECT], CONTRACT_OBJECT, (row, viewer) => {
    const id = uuidOf(row.objectId);
    return sql`COALESCE(
      (SELECT c.created_by FROM contract_records c WHERE c.tenant_id = ${viewer.tenantId} AND c.id = ${id}),
      (SELECT r.created_by FROM contract_requests r WHERE r.tenant_id = ${viewer.tenantId} AND r.id = ${id}))`;
  }),
  orgRule(['organization'], ORG, (row, viewer) =>
    creatorSql(viewer.tenantId, row.objectId, 'org.create', 'organization'),
  ),
  // 逐行回执：归属是导入的组织（冲突行为上级组织），创建人按该组织判断（与 authorizeOrgResult 一致）
  orgRule(['org_import_result'], ORG, (row, viewer) =>
    creatorSql(viewer.tenantId, sql`${row.org}`, 'org.create', 'organization'),
  ),
  // 组织编码预占：业务接口 visible(scope, undefined) 只有看全部才能操作
  { types: ['org_code_reservation'], objectCode: ORG, visible: seeAllOnly },
  orgRule(['establishment-capacity'], ESTABLISHMENT, (row, viewer) =>
    creatorSql(viewer.tenantId, row.objectId, 'establishment.capacity.create', 'establishment-capacity'),
  ),
  {
    // 编制方案没有组织字段：只认看全部（DEC-121 的数据集看全部）或创建人
    types: ['establishment-scheme'],
    objectCode: ESTABLISHMENT,
    view: ESTABLISHMENT_SCHEME_DATASOURCE,
    visible: (scope, row, viewer) =>
      scopeSql(scope, {
        creator: creatorSql(viewer.tenantId, row.objectId, 'establishment.scheme.create', 'establishment-scheme'),
      }),
  },
  { types: ['establishment-copy-job'], objectCode: ESTABLISHMENT, visible: copyJobVisible },
  { types: ['establishment-notification'], objectCode: ESTABLISHMENT, visible: notificationVisible },
  { types: ['establishment-movement'], objectCode: ESTABLISHMENT, visible: movementVisible },
  orgRule(['positions'], JOB_OBJECT_CODES.positions, (row, viewer) =>
    creatorSql(viewer.tenantId, jobObject(row), 'job.create', 'positions'),
  ),
  // 全局职务体系对象没有组织字段：只认看全部或创建人（与职务模块列表一致）
  ...GLOBAL_JOB_KINDS.map((kind): Rule => ({
    types: [kind],
    objectCode: JOB_OBJECT_CODES[kind],
    visible: (scope, row, viewer) =>
      scopeSql(scope, { creator: creatorSql(viewer.tenantId, jobObject(row), 'job.create', kind) }),
  })),
  {
    // 审批实例 / 任务：审批管理员按钮（转交 / 干预 / 查看流程日志）+ 任职或合同范围（与审批中心管理员视图一致）
    types: ['approval-instance', 'approval-task'],
    objectCode: APPROVAL_INSTANCE_OBJECT,
    untrimmed: true,
    resolve: (deps, ctx) => adminScope(deps, ctx, ['adminTransfer', 'adminIntervene', 'adminLogs']),
    visible: (_scope, row, viewer, admin) =>
      admin
        ? sql`EXISTS (SELECT 1 FROM approval_instances i WHERE i.tenant_id = ${viewer.tenantId}
            AND i.id = COALESCE(
              (SELECT t.instance_id FROM approval_tasks t WHERE t.tenant_id = ${viewer.tenantId}
                AND t.id = ${uuidOf(row.objectId)}),
              ${uuidOf(row.objectId)})
            AND ${admin})`
        : sql`false`,
  },
];

/** 复制任务：所有编制都在范围内（或任务由本人创建），与 visibleCopyJob 一致。 */
function copyJobVisible(scope: ModuleScope, row: Row, viewer: Viewer): SQL {
  const id = uuidOf(row.objectId);
  return sql`EXISTS (SELECT 1 FROM establishment_copy_jobs j WHERE j.tenant_id = ${viewer.tenantId} AND j.id = ${id}
    AND EXISTS (SELECT 1 FROM establishment_copy_job_items ci WHERE ci.tenant_id = j.tenant_id AND ci.job_id = j.id)
    AND NOT EXISTS (SELECT 1 FROM establishment_copy_job_items ci
      JOIN establishment_objects co ON co.tenant_id = ci.tenant_id AND co.id = ci.capacity_id
      WHERE ci.tenant_id = j.tenant_id AND ci.job_id = j.id
        AND NOT (${scopeSql(scope, { org: sql`co.org_id`, creator: sql`j.created_by` })})))`;
}

/** 占编：调出、调入组织都在范围内（与编制通知的占编分支一致）。 */
function movementVisible(scope: ModuleScope, row: Row, viewer: Viewer): SQL {
  return sql`EXISTS (SELECT 1 FROM (
      SELECT mv.source_org_id, mv.target_org_id FROM establishment_movement_versions mv
      WHERE mv.tenant_id = ${viewer.tenantId} AND mv.movement_id = ${uuidOf(row.objectId)}
      ORDER BY mv.version_no DESC LIMIT 1) m
    WHERE ${scopeSql(scope, { org: sql`m.source_org_id` })} AND ${scopeSql(scope, { org: sql`m.target_org_id` })})`;
}

/** 编制通知：只有接收人本人，且通知涉及的复制任务 / 占编在范围内（与 listNotifications 一致）。 */
function notificationVisible(scope: ModuleScope, row: Row, viewer: Viewer): SQL {
  const job = copyJobVisible(scope, { ...row, objectId: sql`n.job_id::text` }, viewer);
  const movement = movementVisible(scope, { ...row, objectId: sql`n.movement_id::text` }, viewer);
  return sql`EXISTS (SELECT 1 FROM establishment_notifications n WHERE n.tenant_id = ${viewer.tenantId}
    AND n.id = ${uuidOf(row.objectId)} AND n.recipient_user_id = ${viewer.userId}::uuid
    AND ((n.job_id IS NOT NULL AND ${job}) OR (n.movement_id IS NOT NULL AND ${movement})))`;
}

const RULE_BY_TYPE = new Map(RULES.flatMap((rule) => rule.types.map((type) => [type, rule] as const)));

/** 对象类型是否已登记查看规则（业务规则或 DEC-203 配置对象）；未登记的在审计查询里一律不返回。 */
export function auditObjectRegistered(objectType: string): boolean {
  return RULE_BY_TYPE.has(objectType) || AUDIT_CONFIG_OBJECT_TYPES.has(objectType);
}

interface ResolvedRule {
  readonly rule: Rule;
  readonly scope: ModuleScope;
  readonly extra: SQL | null;
  /** undefined = 不限字段（看全部 / 可信端口 / 审批实例）。 */
  readonly fields: ReadonlySet<string> | undefined;
}

export interface AuditViewer {
  /** 数据变更日志的行级可见谓词（含字段筛选的可见性）。 */
  readonly dataChanges: SQL;
  /** 对象操作日志的行级可见谓词（逐行归属的任务至少一行可见）。 */
  readonly operationLogs: SQL;
  /** 对象操作日志里可见行的行号（jsonb 数组；没有逐行归属的任务为 NULL）。 */
  readonly visibleRows: SQL;
  /** 该日志适用的查看字段；配置类日志（含按动作区分的合同主数据）不限字段。 */
  fieldsOf(objectType: string, action?: string | null): ReadonlySet<string> | undefined;
}

const EVENT = 'audit_events';
const TASK = 'audit_operation_logs';

/** 在查询事务之外解析（范围解析各自开租户事务）；返回的谓词放进查询的 WHERE，分页之前生效。 */
export async function auditViewer(deps: Deps, ctx: TenantContext, field?: string): Promise<AuditViewer> {
  const present = await withTenant(deps.db, ctx.tenantId, (tx) => objectTypesIn(tx, ctx.tenantId));
  const resolved = new Map<Rule, ResolvedRule>();
  for (const type of present) {
    const rule = RULE_BY_TYPE.get(type);
    if (!rule || resolved.has(rule)) continue;
    const entry = await resolveRule(deps, ctx, rule);
    if (entry) resolved.set(rule, entry);
  }
  const viewer = { tenantId: ctx.tenantId, userId: ctx.userId };
  const events = [...resolved.values()].map(
    (entry) => sql`(${eventTypes(entry.rule)} AND ${entry.rule.visible(entry.scope, rowOf(EVENT), viewer, entry.extra)}
      AND ${entry.rule.untrimmed ? sql`true` : fieldScope(entry.fields, field)})`,
  );
  const item = itemRow();
  const tasks = [...resolved.values()].map((entry) => {
    const types = sql`${sql.identifier(TASK)}.object_type = ANY(${textArray(entry.rule.types)})`;
    const itemVisible = entry.rule.visible(entry.scope, item, viewer, entry.extra);
    return {
      whole: sql`(${types} AND (CASE WHEN ${hasItems()}
        THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${sql.identifier(TASK)}.items) item WHERE ${itemVisible})
        ELSE ${entry.rule.visible(entry.scope, rowOf(TASK), viewer, entry.extra)} END))`,
      rows: sql`WHEN ${types} THEN ${itemVisible}`,
    };
  });
  const config = configPredicate(EVENT, true);
  const rowsCase = tasks.length
    ? sql`CASE ${sql.join(
        tasks.map((task) => task.rows),
        sql` `,
      )} ELSE false END`
    : sql`false`;
  return {
    dataChanges: sql`(${sql.join([...events, config], sql` OR `)})`,
    operationLogs: sql`(${sql.join([...tasks.map((task) => task.whole), configPredicate(TASK, false)], sql` OR `)})`,
    visibleRows: sql`(CASE WHEN ${hasItems()} THEN (SELECT COALESCE(jsonb_agg(item->'rowIndex'), '[]'::jsonb)
      FROM jsonb_array_elements(${sql.identifier(TASK)}.items) item WHERE ${rowsCase}) END)`,
    fieldsOf: (objectType, action) => {
      if (action && AUDIT_CONFIG_ACTIONS[objectType]?.includes(action)) return undefined;
      const rule = RULE_BY_TYPE.get(objectType);
      return rule ? resolved.get(rule)?.fields : undefined;
    },
  };
}

async function resolveRule(deps: Deps, ctx: TenantContext, rule: Rule): Promise<ResolvedRule | undefined> {
  if (rule.resolve) {
    const extra = await rule.resolve(deps, ctx);
    return extra
      ? { rule, extra, scope: { all: false, hasDataPermission: true } as ModuleScope, fields: undefined }
      : undefined;
  }
  // 与业务接口 objectContext 同一开关：没有该对象的查看权限，审计里也看不到（第三轮 P1-3）
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: rule.objectCode, fields: [] });
  if (!canView) return undefined;
  const scope = await resolveModuleScope(deps, ctx, undefined, rule.objectCode, undefined, rule.view);
  return { rule, scope, extra: null, fields: await getModuleViewableFields(deps, ctx, rule.objectCode) };
}

function rowOf(table: string): Row {
  const column = (name: string) => sql`${sql.identifier(table)}.${sql.identifier(name)}`;
  return {
    objectId: sql`COALESCE(${column('object_id')}, '')`,
    employee: column('scope_employee_id'),
    org: column('scope_org_id'),
    after: table === EVENT ? column('after') : sql`NULL::jsonb`,
  };
}

function itemRow(): Row {
  return {
    objectId: sql`COALESCE(item->>'objectId', '')`,
    employee: sql`NULLIF(item->>'employeeId', '')::uuid`,
    org: sql`NULLIF(item->>'orgId', '')::uuid`,
    after: sql`NULL::jsonb`,
  };
}

const hasItems = () => {
  const items = sql`${sql.identifier(TASK)}.items`;
  return sql`(jsonb_typeof(${items}) = 'array' AND jsonb_array_length(${items}) > 0)`;
};

/** 数据变更日志按对象类型匹配规则；与配置共用对象类型的写入（合同主数据）按动作排除。 */
function eventTypes(rule: Rule): SQL {
  const table = sql.identifier(EVENT);
  const configActions = rule.types.flatMap((type) => AUDIT_CONFIG_ACTIONS[type] ?? []);
  const types = sql`${table}.object_type = ANY(${textArray(rule.types)})`;
  return configActions.length ? sql`(${types} AND ${table}.action <> ALL(${textArray(configActions)}))` : types;
}

/** DEC-203：配置类日志持日志审计即可见（字段权限不适用：配置对象没有字段权限定义）。 */
function configPredicate(table: string, withActions: boolean): SQL {
  const t = sql.identifier(table);
  const types = sql`${t}.object_type = ANY(${textArray([...AUDIT_CONFIG_OBJECT_TYPES])})`;
  if (!withActions) return types;
  const actions = Object.entries(AUDIT_CONFIG_ACTIONS).map(
    ([type, list]) => sql`(${t}.object_type = ${type} AND ${t}.action = ANY(${textArray(list)}))`,
  );
  return sql`(${sql.join([types, ...actions], sql` OR `)})`;
}

/** 至少一个可见字段发生变化；带字段筛选时该字段本身也必须可见。 */
function fieldScope(fields: ReadonlySet<string> | undefined, field: string | undefined): SQL {
  if (fields === undefined) return sql`true`;
  if (field !== undefined && !fields.has(auditFieldCode(field))) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${sql.identifier(EVENT)}.changes, '[]'::jsonb))
      visible_change
    WHERE (CASE WHEN visible_change->>'field' LIKE 'customFields.%'
      THEN 'custom:' || substr(visible_change->>'field', 14)
      ELSE regexp_replace(visible_change->>'field', '^.*\\.', '') END) = ANY(${textArray([...fields])}))`;
}

/** 本租户日志里出现过的对象类型（松散索引扫描，按 (tenant_id, object_type) 索引逐个跳读）。 */
async function objectTypesIn(tx: Tx, tenantId: string): Promise<string[]> {
  const found = new Set<string>();
  for (const table of [EVENT, TASK]) {
    const name = sql.identifier(table);
    const result = await tx.execute(sql`WITH RECURSIVE found AS (
        (SELECT object_type FROM ${name} WHERE tenant_id = ${tenantId} ORDER BY object_type LIMIT 1)
        UNION ALL
        SELECT (SELECT n.object_type FROM ${name} n WHERE n.tenant_id = ${tenantId}
                 AND n.object_type > found.object_type ORDER BY n.object_type LIMIT 1)
          FROM found WHERE found.object_type IS NOT NULL
      ) SELECT object_type FROM found WHERE object_type IS NOT NULL`);
    const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as { object_type: string }[];
    for (const row of rows) found.add(row.object_type);
  }
  return [...found].sort();
}

function textArray(values: readonly string[]): SQL {
  return sql`${`{${values.map(quote).join(',')}}`}::text[]`;
}

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** 差异只留可见字段。 */
export function visibleChanges(
  changes: readonly AuditFieldChange[],
  fields: ReadonlySet<string> | undefined,
): AuditFieldChange[] {
  return fields === undefined ? [...changes] : changes.filter((change) => fields.has(auditFieldCode(change.field)));
}

/** 前后值 / 快照只留可见字段；嵌套的 fields / customFields 等容器逐层裁剪，空容器去掉。 */
export function visibleValue(value: unknown, fields: ReadonlySet<string> | undefined, prefix = ''): unknown {
  if (fields === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner) && !prefix) {
      const nested = visibleValue(inner, fields, path) as Record<string, unknown>;
      if (Object.keys(nested).length) kept[key] = nested;
    } else if (fields.has(auditFieldCode(path))) {
      kept[key] = inner;
    }
  }
  return kept;
}

/**
 * 任务错误报告：行号、错误码、原因是任务协议信息；出错字段的编码（field）按该字段的查看权限保留，
 * 其余（来源编码、编码等）按字段权限裁剪；只保留可见行（rows 为 undefined 表示不按行裁剪）。
 */
export function visibleErrorReport(
  report: unknown,
  fields: ReadonlySet<string> | undefined,
  rows?: ReadonlySet<number>,
): unknown {
  if (!Array.isArray(report)) return report;
  const inRows = (entry: unknown) =>
    rows === undefined ||
    (typeof (entry as { rowIndex?: unknown })?.rowIndex === 'number' &&
      rows.has((entry as { rowIndex: number }).rowIndex));
  const kept = report.filter(inRows);
  if (fields === undefined) return kept;
  const protocol = new Set(['rowIndex', 'errorCode', 'reason']);
  return kept.map((entry) =>
    entry && typeof entry === 'object'
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).filter(
            ([key, value]) =>
              protocol.has(key) ||
              (key === 'field' ? typeof value === 'string' && fields.has(auditFieldCode(value)) : fields.has(key)),
          ),
        )
      : entry,
  );
}
