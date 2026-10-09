import { CapacityAuditFields, capacityAuditChanges, visibleCapacityParts } from './establishment-capacity.js';
import { NestedAuditFields, type NestedChildren, visibleNested, visibleNestedChanges } from './nested-fields.js';
/**
 * DEC-197 / DEC-203（PR #75 第二、三轮）：审计查询按查看人**当前**的数据范围与字段权限裁剪，不设全量读取特权。
 * 「日志审计」能力只决定能不能进入查询；每条日志能否返回，按它的对象类型复用**该业务对象自己的查看规则**：
 * - 每种写入审计的对象类型都在下方逐个登记（RULES / 配置对象），未登记的对象类型一律不返回（fail-closed）；
 * - 业务对象先要有该对象的查看权限（与业务接口 objectContext 同一 object.view），再按业务列表 / 详情的同一 SQL 谓词
 *   判断范围：任职 DEC-177、人员与合同按所属人员、组织 / 编制 / 职位按所属组织、全局职务体系对象与编制方案只认
 *   看全部或“使用用户（创建人）”、人才标准对象（R3-T01，DEC-281⑨）按所属管理单元（字典只认看全部或创建人）、编制复制任务 / 通知 / 占编按其业务规则、组织编码预占只认看全部、审批实例按
 *   审批管理员按钮与任职 / 合同范围；
 * - 需要归属的对象推导不出所属人员 / 组织时不返回（第三轮 P1-1：“推导失败”不等于“无归属”）；
 * - “使用用户”维度按保留的创建人元数据（DEC-198，audit_object_creators）或模块真实的创建人列判断（第三轮 P2-1）；
 * - 真正的配置对象（DEC-203）持日志审计即可见，但字段权限照常裁剪（第四轮 N1：按配置对象或动作映射的权限对象）；
 * - 人员派生的汇总计数（序码重算的变化人数）按可见的逐人日志重新计数（第四轮 N4）；审批日志只展示流程字段；
 * - 跨人员 / 组织的任务日志按逐行归属判断（第三轮 P1-2）：至少一行可见才返回，汇总与错误报告只按可见行计算。
 * 行级判断全部在 SQL 里、分页之前完成；字段按该对象当前查看字段裁剪，至少一个可见字段变化的日志才返回。
 */
import { AUTHORIZATION_TABLES, sql, type Tx, withTenant } from '@italent/db';
import {
  APPROVAL_INSTANCE_OBJECT,
  AUDIT_CONFIG_ACTIONS,
  AUDIT_CONFIG_OBJECT_TYPES,
  auditFieldCode,
  type AuditFieldChange,
  CONTRACT_OBJECT,
  ESTABLISHMENT_SCHEME_DATASOURCE,
  EVALUATION_AUDIT_ACTIONS,
  EVALUATION_OBJECTS,
  EVALUATION_ORG_OBJECTS,
  IDP_OBJECTS,
  linkedViewable,
  MODULE_OBJECTS,
  PERSONNEL_OBJECT,
  PERSONNEL_REQUEST_OBJECT,
  QUALIFICATION_AUDIT_ACTIONS,
  QUALIFICATION_OBJECTS,
  QUALIFICATION_ORG_AUDITED,
  SUBSETS,
  survey360,
  TALENT_OBJECTS,
  TALENT_REVIEW_CONFIG_OBJECTS,
  TALENT_REVIEW_OBJECTS,
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
import { survey360AuditScope } from '../modules/survey360/access.js';
import { survey360PersonAuditFields } from './survey360-person.js';
import { IDP_AUDIT_ACTIONS, IDP_ORG_OBJECTS, IDP_PERSON_OBJECTS } from '../modules/idp/access.js';
import { KEY_INFO, keyInfoScopeSql, keyInfoSnapshot, type KeyInfoSpec } from '../modules/idp/key-info-scope.js';
import {
  isDictionary as isTalentDictionary,
  TALENT_AUDIT_ACTIONS,
  type TalentObject,
} from '../modules/talent/access.js';
import { MODEL_IMAGE_AUDIT_TYPE } from '../modules/talent/model-image-service.js';
import { TALENT_REVIEW_AUDIT_ACTIONS } from '../modules/talent-review/access.js';
import {
  ExactAuditFields,
  resolveLinkageAudit,
  transferEmployee,
  TRANSFER_LINKAGE,
  type LinkageAudit,
} from './transfer-linkage.js';

/**
 * 一条日志（或任务的一行）在规则里可用的列：对象编号（text）、所属人员 / 组织（uuid）、写入后的值（jsonb）、
 * 命令编号；任务日志另有执行人（actor），作为“使用用户”维度的回退创建人（第四轮 N2）。
 */
interface Row {
  readonly objectId: SQL;
  readonly employee: SQL;
  readonly org: SQL;
  readonly before: SQL;
  readonly after: SQL;
  readonly commandId: SQL;
  readonly actor: SQL | null;
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
  /**
   * 固定的可见字段（不按字段权限解析）：审批实例日志只展示流程字段白名单（白名单以外的键——例如将来写入的业务
   * 快照——一律不展示，第四轮口径“整条展示不等于业务字段值免裁剪”）；序码重算汇总只展示运行元数据与重新计数的条数。
   */
  readonly fixedFields?: readonly string[];
  readonly visible: (scope: ModuleScope, row: Row, viewer: Viewer, resolved: RuleInputs) => SQL;
  /** 规则需要的额外谓词（如审批管理员范围，对 approval_instances 别名 i）；返回 null 表示没有权限。 */
  readonly resolve?: (deps: Deps, ctx: TenantContext) => Promise<SQL | null>;
  /**
   * 带 resolve 的规则同样先要 objectCode 的查看权，再按该对象的查看字段裁剪（R3-T03 第 3 轮 R2-P2-4：360 日志按
   * 真实对象判定）；不设时保持原样（审批实例等只按 resolve 与固定字段）。
   */
  readonly objectPermission?: boolean;
  /** 不是对象字段的协议键（删除 / 移除标记、活动授权名单等），随对象字段一起展示。 */
  readonly protocol?: readonly string[];
  /**
   * 脱敏出口（DEC-340③ 答卷日志）：对任何查看人都去掉 hidden 字段，按动作再去掉 byAction 的字段；列表与详情不展示
   * 命令 ID、请求来源与对象编号，按这些条件筛选也查不到（auditDesensitized）。数据库里的快照照常保存。
   */
  readonly desensitize?: {
    readonly hidden: readonly string[];
    readonly byAction?: Readonly<Record<string, readonly string[]>>;
  };
}

type Deps = TenantRouteDeps;

/** 规则解析出的附加输入：额外谓词（审批管理员范围）与该权限对象的查看字段。 */
interface RuleInputs {
  readonly extra: SQL | null;
  readonly objectFields: ReadonlySet<string> | undefined;
}

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
/**
 * 需要归属的对象：看全部照常可见；归属为空（推导失败、格式失败的导入行）时只能按“使用用户”维度判断——
 * 数据变更日志的创建人取对象本身（推导失败的对象查不到创建人，仍不可见），任务行回退为执行人（第四轮 N2）。
 */
const anchored = (scope: ModuleScope, anchor: SQL, predicate: SQL, creator?: SQL) => {
  if (scope.all) return sql`true`;
  const byCreator = creator ? scopeSql(scope, { creator }) : sql`false`;
  return sql`((${anchor} IS NOT NULL AND ${predicate}) OR (${anchor} IS NULL AND ${byCreator}))`;
};
const seeAllOnly = (scope: ModuleScope) => (scope.all ? sql`true` : sql`false`);
/**
 * “使用用户”维度的创建人（第四轮 N2）：数据变更日志按对象的创建人；任务行先按行里的业务对象编号取创建人，
 * 没有对象（冲突、格式失败的行）或对象没有创建人记录时，回退为任务的执行人——本人执行的任务对本人可见。
 */
const ownedBy = (row: Row, creator: SQL) =>
  row.actor
    ? sql`(CASE WHEN ${row.objectId} = '' THEN ${row.actor} ELSE COALESCE(${creator}, ${row.actor}) END)`
    : creator;
/** 职务体系的逐行回执以“命令:行号”为对象编号，回执里的 objectId 才是职务对象。 */
const jobObject = (row: Row) => sql`COALESCE(NULLIF(${row.after}->>'objectId', ''), ${row.objectId})`;

function personRule(types: readonly string[], objectCode: string, creator: (row: Row, viewer: Viewer) => SQL): Rule {
  return {
    types,
    objectCode,
    visible: (scope, row, viewer) => {
      const owner = ownedBy(row, creator(row, viewer));
      return anchored(scope, row.employee, scopeSql(scope, { person: row.employee, creator: owner }), owner);
    },
  };
}

function orgRule(types: readonly string[], objectCode: string, creator: (row: Row, viewer: Viewer) => SQL): Rule {
  return {
    types,
    objectCode,
    visible: (scope, row, viewer) => {
      const owner = ownedBy(row, creator(row, viewer));
      return anchored(scope, row.org, scopeSql(scope, { org: row.org, creator: owner }), owner);
    },
  };
}

/** 配置对象的审计查看规则：按所属组织裁剪的对象用 orgRule，其余按字典（看全部或创建人）。 */
function appConfigRules<K extends string>(
  objects: Readonly<Record<K, { readonly code: string }>>,
  actions: Readonly<Record<K, string>>,
  orgObjects: readonly K[],
): Rule[] {
  return (Object.keys(objects) as K[]).map((object): Rule => {
    const code = objects[object].code;
    const creator = (row: Row, viewer: Viewer) =>
      creatorSql(viewer.tenantId, row.objectId, `${actions[object]}.create`, code);
    if (orgObjects.includes(object)) return orgRule([code], code, creator);
    return {
      types: [code],
      objectCode: code,
      visible: (scope, row, viewer) => scopeSql(scope, { creator: ownedBy(row, creator(row, viewer)) }),
    };
  });
}

/** DEC-197：业务编号解析到当前员工范围；创建人仍取调动业务，不取联动日志执行人。 */
function transferLinkageRule(): Rule {
  const person = personRule([TRANSFER_LINKAGE], EMPLOYMENT, (row, viewer) =>
    employmentCreator(viewer.tenantId, sql`lower(${row.objectId})`, true),
  );
  return {
    ...person,
    visible: (scope, row, viewer, inputs) => {
      const employee = transferEmployee(viewer.tenantId, row.objectId);
      return sql`(${employee} IS NOT NULL AND ${person.visible(scope, { ...row, employee }, viewer, inputs)})`;
    },
  };
}

/** 审批日志的流程字段白名单（状态、节点、任务、审批人、意见等）；不含被隐藏字段清单等其他键。 */
export const APPROVAL_FLOW_FIELDS = [
  'status',
  'currentNodeKey',
  'returnedFromNodeKey',
  'round',
  'historyFromSeq',
  'revision',
  'versionId',
  'taskId',
  'taskStatus',
  'assigneeUserId',
  'candidateUserId',
  'mergedCandidateUserIds',
  'newTaskId',
  'newTaskIds',
  'newTaskStatus',
  'signers',
  'nodeKey',
  'recipients',
  'ccUserIds',
  'comment',
  'reason',
  'adminSelfTransfer',
  'isExceptionAdmin',
  'instanceId',
  'parentTaskId',
  'activationId',
  'origin',
];

/**
 * R3-T03：360 日志按真实对象判定（第 3 轮 R2-P2-4）——先要该 360 对象的查看权，再按该对象的查看字段裁剪；可见条件
 * 与接口同一判定（survey360/access.ts）：活动按活动可见；评价对象 / 评价关系 / 确认单按评价关系对象、答卷按答卷
 * 对象，且活动可见、精细化权限生效时一律不可见；答卷类日志同此可见，只展示脱敏版本（DEC-340③）；待办按评价关系对象、
 * 报告生成与转发按结果对象，同评价关系的可见条件；人员按人员对象（精细化生效时不可见）；同步冲突另须同步按钮与员工
 * 信息查看权、冲突员工在查看人当前员工范围内（第 4 轮 R3-P2-2），只展示冲突协议字段；评价角色 / 设置、套卷有对象
 * 查看权即可见。活动内对象的写入一律在 after 里带 activityId，同步冲突的 after 带 employeeId。
 */
const S360 = survey360.SURVEY360_OBJECTS;
const OBJECT_FIELDS = new Map<string, string[]>(
  Object.values(S360).map((object) => [object.code, object.fields.map((field) => field.code)]),
);

/**
 * DEC-340③：答卷日志（保存、提交、屏蔽、恢复、清除、替换套卷清空）对任何查看人（含持“全部活动”者）只给脱敏版本：
 * 去掉评价关系 ID；不展示命令 ID、作答请求的来源（IP、终端、来源页、TraceID）与答卷编号——管理员可凭自己的命令 ID
 * 或匿名卡片编号把答卷对到具名评价关系（第 3 轮 P2-2）；清除是对具名评价关系做的，清除事件再去掉答案与评语。
 * 链接 / 待办作答的操作人本就记为“系统”。答案本身与原始数据卡片一样不带评价者标识。
 */
const SURVEY360_SHEET_DESENSITIZE = {
  hidden: ['relationId'],
  byAction: { 'survey360.sheet.clear': ['answers', 'suggestion'] },
} as const;
const inVisibleActivity: Rule['visible'] = (_scope, row, _viewer, { extra }) =>
  extra ? sql`COALESCE(${row.after}->>'activityId', '') IN (${extra})` : sql`false`;
const byResolve: Rule['visible'] = (_scope, _row, _viewer, { extra }) => extra ?? sql`false`;
const byConflictEmployee: Rule['visible'] = (_scope, row, _viewer, { extra }) =>
  extra ? sql`COALESCE(${row.after}->>'employeeId', '') IN (${extra})` : sql`false`;
const survey360Rules: readonly Rule[] = [
  {
    types: ['survey360-activity'],
    objectCode: S360.activity.code,
    objectPermission: true,
    protocol: ['activityId', 'userIds', 'deleted'],
    resolve: survey360AuditScope('activity'),
    visible: inVisibleActivity,
  },
  {
    types: ['survey360-object', 'survey360-relation', 'survey360-confirmation'],
    objectCode: S360.relation.code,
    objectPermission: true,
    protocol: ['removed'],
    resolve: survey360AuditScope('relation'),
    visible: inVisibleActivity,
  },
  {
    types: ['survey360-sheet'],
    objectCode: S360.answer.code,
    objectPermission: true,
    resolve: survey360AuditScope('answer'),
    desensitize: SURVEY360_SHEET_DESENSITIZE,
    visible: inVisibleActivity,
  },
  {
    types: ['survey360-todo'],
    objectCode: S360.relation.code,
    objectPermission: true,
    // 第 2 轮 P2-6：不用固定字段清单绕过字段权限，人员 ID、状态按评价关系对象的查看字段裁剪
    protocol: ['activityId'],
    resolve: survey360AuditScope('relation'),
    visible: inVisibleActivity,
  },
  {
    types: ['survey360-report'],
    objectCode: S360.result.code,
    objectPermission: true,
    // 第 2 轮 P2-6：生成时间、模板、收件人邮箱按结果对象的查看字段裁剪；人数是转发回执的协议字段
    protocol: ['activityId', 'reportCount', 'recipientCount', 'unresolvedReports'],
    resolve: survey360AuditScope('relation'),
    visible: inVisibleActivity,
  },
  {
    types: ['survey360-person'],
    objectCode: S360.person.code,
    objectPermission: true,
    resolve: survey360AuditScope('person'),
    visible: byResolve,
  },
  {
    types: ['survey360-sync-conflict'],
    objectCode: S360.person.code,
    objectPermission: true,
    fixedFields: [
      'id',
      'employeeId',
      'candidatePersonIds',
      'matchedBy',
      'status',
      'resolution',
      'resolvedPersonId',
      'revision',
    ],
    resolve: survey360AuditScope('sync'),
    visible: byConflictEmployee,
  },
  { types: ['survey360-role', 'survey360-settings'], objectCode: S360.settings.code, visible: () => sql`true` },
  {
    types: ['survey360-questionnaire'],
    objectCode: S360.questionnaire.code,
    protocol: ['deleted'],
    visible: () => sql`true`,
  },
];

const RULES: readonly Rule[] = [
  {
    types: ['Account.Avatar'],
    objectCode: 'Account.Avatar',
    fixedFields: [
      'revision',
      'avatar',
      'avatar.id',
      'avatar.filename',
      'avatar.contentType',
      'avatar.byteSize',
      'avatar.sha256',
      'avatar.status',
    ],
    resolve: async () => sql`true`,
    visible: (_scope, row, viewer) => sql`${row.objectId}=${viewer.userId} AND ${row.actor}=${viewer.userId}::uuid`,
  },
  ...survey360Rules,
  {
    // DEC-216 / F-007：联动汇总按任职查看规则判定，人数按本组织本次联动的可见逐条审计重算。
    types: ['org-adjustment-run'],
    objectCode: EMPLOYMENT,
    fixedFields: ['effectiveDate', 'employeeCount'],
    visible: (scope, row, viewer, inputs) =>
      sql`EXISTS (${orgAdjustmentChildren(scope, row, viewer, inputs.objectFields)})`,
  },
  {
    // DEC-216 / F-021：任务回执只走逐条归属的操作日志，不公开 outbox 请求/完成载荷里的全量目标数组。
    types: ['job-sequence-sync'],
    objectCode: EMPLOYMENT,
    visible: (scope, row, viewer, inputs) => {
      if (inputs.objectFields && !inputs.objectFields.has('sequenceId')) return sql`false`;
      const owner = employmentCreator(viewer.tenantId, row.objectId, true);
      return sql`(${row.after} IS NULL AND ${row.employee} IS NOT NULL AND ${employmentVisibilitySql(scope, {
        employee: row.employee,
        department: row.org,
        creator: owner,
      })})`;
    },
  },
  {
    types: ['employment-record', 'employment-business', 'transfer-request', 'employment_assignment'],
    objectCode: EMPLOYMENT,
    visible: (scope, row, viewer) => {
      const owner = ownedBy(row, employmentCreator(viewer.tenantId, row.objectId, true));
      const visible = employmentVisibilitySql(scope, { employee: row.employee, department: row.org, creator: owner });
      return anchored(scope, row.employee, visible, owner);
    },
  },
  transferLinkageRule(),
  personRule(['employment_employee'], 'TenantBase.Employee', (row, viewer) =>
    employmentCreator(viewer.tenantId, row.employee),
  ),
  personRule([PERSONNEL_OBJECT, 'personnel-order-code'], PERSONNEL_OBJECT, (row, viewer) =>
    employmentCreator(viewer.tenantId, row.employee),
  ),
  {
    // 序码重算汇总（第四轮 N4）：变化人数是人员派生计数，不能按配置公开——同一命令的逐人序码日志至少一条可见才返回，
    // 展示的变化人数按可见的逐人日志重新计数（routes.ts）；看全部的查看人看到原值
    types: ['personnel-order-run'],
    objectCode: PERSONNEL_OBJECT,
    fixedFields: ['changed', 'businessDate', 'outcome', 'revision'],
    visible: (scope, row, viewer, inputs) =>
      scope.all ? sql`true` : sql`EXISTS (${orderCodeChildren(scope, row, viewer, inputs.objectFields)})`,
  },
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
  // DEC-216 / F-018：带编增减与回退沿用容量对象归属；细分数组另按子字段投影。
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
        creator: ownedBy(
          row,
          creatorSql(viewer.tenantId, row.objectId, 'establishment.scheme.create', 'establishment-scheme'),
        ),
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
      scopeSql(scope, { creator: ownedBy(row, creatorSql(viewer.tenantId, jobObject(row), 'job.create', kind)) }),
  })),
  // R3-T01 人才标准（TalentCenter，DEC-281⑨）：与业务接口一致按所属管理单元（日志写入时的所属组织）裁剪，“使用用户”
  // 按保留的创建元数据（DEC-198，对象删除后仍可判断）；发展建议类型是字典，只认看全部或创建人（DEC-121）
  ...(Object.keys(TALENT_OBJECTS) as TalentObject[]).map((object): Rule => {
    const code = TALENT_OBJECTS[object].code;
    const creator = (row: Row, viewer: Viewer) =>
      creatorSql(viewer.tenantId, row.objectId, `${TALENT_AUDIT_ACTIONS[object]}.create`, code);
    if (!isTalentDictionary(object)) return orgRule([code], code, creator);
    return {
      types: [code],
      objectCode: code,
      visible: (scope, row, viewer) => scopeSql(scope, { creator: ownedBy(row, creator(row, viewer)) }),
    };
  }),
  // R3-T04 人才盘点设置类对象（准备度等，设计 §6.1 configRule）：没有组织字段，只认看全部或创建人（DEC-121），
  // 创建人按保留的创建元数据判断（DEC-198，删除后仍可判断）；字段按对象当前字段权限裁剪
  ...TALENT_REVIEW_CONFIG_OBJECTS.map((object): Rule => {
    const code = TALENT_REVIEW_OBJECTS[object].code;
    return {
      types: [code],
      objectCode: code,
      visible: (scope, row, viewer) =>
        scopeSql(scope, {
          creator: ownedBy(
            row,
            creatorSql(viewer.tenantId, row.objectId, `${TALENT_REVIEW_AUDIT_ACTIONS[object]}.create`, code),
          ),
        }),
    };
  }),
  {
    // Q-M0-126：模型图没有独立可见性设置，日志同样随标准对象查看权与当前管理单元范围。
    ...orgRule([MODEL_IMAGE_AUDIT_TYPE], TALENT_OBJECTS.criterion.code, (row, viewer) =>
      creatorSql(viewer.tenantId, row.objectId, 'talent.criterion.create', TALENT_OBJECTS.criterion.code),
    ),
    fixedFields: [
      'modelImage',
      'revision',
      'modelImage.id',
      'modelImage.filename',
      'modelImage.contentType',
      'modelImage.byteSize',
      'modelImage.sha256',
      'modelImage.status',
    ],
  },
  {
    // 审批实例 / 任务：审批管理员按钮（转交 / 干预 / 查看流程日志）+ 任职或合同范围（与审批中心管理员视图一致）
    types: ['approval-instance', 'approval-task'],
    objectCode: APPROVAL_INSTANCE_OBJECT,
    fixedFields: APPROVAL_FLOW_FIELDS,
    resolve: (deps, ctx) => adminScope(deps, ctx, ['adminTransfer', 'adminIntervene', 'adminLogs']),
    visible: (_scope, row, viewer, { extra: admin }) =>
      admin
        ? sql`EXISTS (SELECT 1 FROM approval_instances i WHERE i.tenant_id = ${viewer.tenantId}
            AND i.id = COALESCE(
              (SELECT t.instance_id FROM approval_tasks t WHERE t.tenant_id = ${viewer.tenantId}
                AND t.id = ${uuidOf(row.objectId)}),
              ${uuidOf(row.objectId)})
            AND ${admin})`
        : sql`false`,
  },
  // R3-T07 个人发展计划配置（IDP 应用，PR 描述矩阵 A）：与业务接口一致按所属组织（日志写入时流程 / 模板的所属组织）
  // 裁剪，“使用用户”按保留的创建元数据（DEC-198）；向下公开只放开业务查看与选用，不放开审计（🟡 K-23）
  ...IDP_ORG_OBJECTS.map((object): Rule => {
    const code = IDP_OBJECTS[object].code;
    return orgRule([code], code, (row, viewer) =>
      creatorSql(viewer.tenantId, row.objectId, `${IDP_AUDIT_ACTIONS[object]}.create`, code),
    );
  }),
  // R3-T02 任职资格（Qualification）与人才评定配置（TEvaluation），设计 §8：带资源集合 / 所属组织的对象按日志写入时的
  // 所属组织裁剪，不因向下公开放宽；字典只认看全部或创建人（DEC-121）。流程对象（员工评定数据等）随 C2 登记。
  ...appConfigRules(QUALIFICATION_OBJECTS, QUALIFICATION_AUDIT_ACTIONS, QUALIFICATION_ORG_AUDITED),
  ...appConfigRules(EVALUATION_OBJECTS, EVALUATION_AUDIT_ACTIONS, EVALUATION_ORG_OBJECTS),
  // R3-T07 PR-B：计划及其组成部分按计划员工、关键信息按员工（带教按被带教人）归属，与业务接口的范围一致（K-50）；
  // 关键信息另要求日志前后快照涉及的全部员工 / 组织都在范围内（带教双方、轮岗部门，第 2 轮 P2-1）
  ...IDP_PERSON_OBJECTS.map((object): Rule => {
    const code = IDP_OBJECTS[object].code;
    const rule = personRule([code], code, (row, viewer) =>
      creatorSql(viewer.tenantId, row.objectId, `${IDP_AUDIT_ACTIONS[object]}.create`, code),
    );
    const spec = (KEY_INFO as Partial<Record<string, KeyInfoSpec>>)[object];
    if (!spec) return rule;
    const snapshot = (scope: ModuleScope, value: SQL) =>
      sql`(${value} IS NULL OR ${keyInfoScopeSql(scope, spec, keyInfoSnapshot(value))})`;
    return {
      ...rule,
      visible: (scope, row, viewer, inputs) =>
        sql`(${rule.visible(scope, row, viewer, inputs)} AND ${snapshot(scope, row.before)}
          AND ${snapshot(scope, row.after)})`,
    };
  }),
];

/** 同一次序码重算命令写下的、查看人可见的逐人序码日志（别名 p）。 */
function orderCodeChildren(scope: ModuleScope, row: Row, viewer: Viewer, fields?: ReadonlySet<string>): SQL {
  const child: Row = {
    objectId: sql`p.object_id`,
    employee: sql`p.scope_employee_id`,
    org: sql`p.scope_org_id`,
    before: sql`p.before`,
    after: sql`p.after`,
    commandId: sql`p.command_id`,
    actor: null,
  };
  const person = scopeSql(scope, {
    person: child.employee,
    creator: employmentCreator(viewer.tenantId, child.employee),
  });
  return sql`SELECT 1 FROM audit_events p WHERE p.tenant_id = ${viewer.tenantId}
    AND p.object_type = 'personnel-order-code' AND p.command_id = ${row.commandId}
    AND ${anchored(scope, child.employee, person)} AND ${changedVisible('p', fields)}`;
}

/** 通过同事务 outbox 的组织归属区分同一导入命令里的多行，不能把整批人数算给每个组织。 */
function orgAdjustmentChildren(scope: ModuleScope, row: Row, viewer: Viewer, fields?: ReadonlySet<string>): SQL {
  const visible = employmentVisibilitySql(scope, {
    employee: sql`p.scope_employee_id`,
    department: sql`p.scope_org_id`,
    creator: employmentCreator(viewer.tenantId, sql`p.object_id`, true),
  });
  return sql`SELECT 1 FROM audit_events p WHERE p.tenant_id=${viewer.tenantId}
    AND p.command_id=${row.commandId} AND p.object_type='employment-record' AND p.action='employment.record.create'
    AND EXISTS (SELECT 1 FROM employment_outbox o WHERE o.tenant_id=p.tenant_id AND o.command_id=p.command_id
      AND o.object_id=${uuidOf(sql`p.object_id`)} AND o.event_type=p.action
      AND o.payload->'meta'->>'organizationId'=${row.objectId})
    AND p.scope_employee_id IS NOT NULL AND ${visible} AND ${changedVisible('p', fields)}`;
}

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
  readonly linkage?: LinkageAudit;
  readonly rule: Rule;
  readonly scope: ModuleScope;
  readonly inputs: RuleInputs;
  /** 展示与字段筛选用的查看字段；undefined = 不限字段（看全部 / 可信端口）。 */
  readonly fields: ReadonlySet<string> | undefined;
}

/**
 * 配置类日志的字段权限（第四轮 N1）：DEC-203 只放宽“谁能看到”，字段权限照常——有字段权限定义的配置对象按其权限
 * 对象裁剪差异、文本、前后值与字段筛选；合同主数据按动作映射；调动表单按任职字段裁剪表单里的字段配置；恢复对账
 * 只展示授权镜像与流程重新发布的条数（接管任务数、问题清单属于业务派生信息，不在审计中展示）。
 * 未列出的配置对象（企业设置、权限、许可、各模块的开关类设置）没有字段权限定义，不裁剪。
 */
interface ConfigFields {
  /** 字段权限对象。 */
  readonly code?: string;
  /** 始终可见的协议键（如表单名称）。 */
  readonly protocol?: readonly string[];
  /** 调动表单：字段配置里的预置字段写作 preset:<字段>，按任职字段 <字段> 判断。 */
  readonly presets?: boolean;
  /** 固定可见的键（不按字段权限解析）。 */
  readonly fixed?: readonly string[];
}

const CONFIG_FIELDS_BY_TYPE: Readonly<Record<string, ConfigFields>> = {
  employment_settings: { code: 'TenantBase.EmploymentSettings' },
  transfer_settings: { code: 'TenantBase.EmploymentSettings' },
  employment_custom_field: { code: 'TenantBase.EmploymentCustomField' },
  'approval-process': { code: 'TenantBase.ApprovalProcess' },
  transfer_form: {
    code: EMPLOYMENT,
    presets: true,
    protocol: ['id', 'name', 'processCode', 'grouped', 'isStandard', 'customMode', 'autoPopulate', 'revision'],
  },
};

const CONFIG_FIELDS_BY_ACTION: Readonly<Record<string, ConfigFields>> = {
  'contract.types.save': { code: MODULE_OBJECTS.contractType.code },
  'contract.companies.save': { code: MODULE_OBJECTS.contractCompany.code },
  'contract.rule.save': { code: MODULE_OBJECTS.contractRules.code },
  'contract.settings.update': { code: MODULE_OBJECTS.contractSettings.code },
  // 恢复对账只展示授权镜像各表的改动条数（按明确路径 changed.<授权表>）、跳过数与流程重新发布数（第五轮 P3）
  'tenant.restore.reconcile': {
    fixed: [...AUTHORIZATION_TABLES.map((table) => `changed.${table}`), 'skipped', 'republished'],
  },
};

export interface AuditViewer {
  /** 数据变更日志的行级可见谓词（含字段筛选的可见性）。 */
  readonly dataChanges: SQL;
  /** 对象操作日志的行级可见谓词（逐行归属的任务至少一行可见）。 */
  readonly operationLogs: SQL;
  /** 对象操作日志里可见行的行号（jsonb 数组；没有逐行归属的任务为 NULL）。 */
  readonly visibleRows: SQL;
  /** 人员派生计数按可见行重新计算的结果（序码重算汇总的变化人数，第四轮 N4）；不需要重算的为 NULL。 */
  readonly visibleCount: SQL;
  /** 联动逐条解析的完整可见路径与展开差异；其他对象保持原始 changes。 */
  readonly linkagePaths: SQL;
  readonly eventChanges: SQL;
  /** 该日志适用的查看字段；undefined = 不限字段。 */
  fieldsOf(
    objectType: string,
    action?: string | null,
    paths?: readonly string[] | null,
  ): ReadonlySet<string> | undefined;
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
  const config = await resolveConfigFields(deps, ctx, present);
  const viewer = { tenantId: ctx.tenantId, userId: ctx.userId };
  const events = [...resolved.values()].map(
    (entry) => sql`(${eventTypes(entry.rule)}
      AND ${entry.rule.visible(entry.scope, rowOf(EVENT), viewer, entry.inputs)}
      AND ${entry.linkage?.visible ?? sql`true`}
      AND ${entry.linkage?.matches(field) ?? fieldScope(entry.fields, field)})`,
  );
  const item = itemRow();
  // transfer-linkage 目前只写数据变更事件；未来新增任务写入须单独登记逐行字段规则。
  const tasks = [...resolved.values()]
    .filter((entry) => !entry.linkage)
    .map((entry) => {
      const types = sql`${sql.identifier(TASK)}.object_type = ANY(${textArray(entry.rule.types)})`;
      const itemVisible = entry.rule.visible(entry.scope, item, viewer, entry.inputs);
      return {
        whole: sql`(${types} AND (CASE WHEN ${hasItems()}
        THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${sql.identifier(TASK)}.items) item WHERE ${itemVisible})
        ELSE ${entry.rule.visible(entry.scope, rowOf(TASK), viewer, entry.inputs)} END))`,
        rows: sql`WHEN ${types} THEN ${itemVisible}`,
      };
    });
  const rowsCase = tasks.length
    ? sql`CASE ${sql.join(
        tasks.map((task) => task.rows),
        sql` `,
      )} ELSE false END`
    : sql`false`;
  const orderRun = RULE_BY_TYPE.get('personnel-order-run')!;
  const run = resolved.get(orderRun);
  const orgRun = resolved.get(RULE_BY_TYPE.get('org-adjustment-run')!);
  const linkage = [...resolved.values()].find((entry) => entry.linkage)?.linkage;
  const capacityFields = resolved.get(RULE_BY_TYPE.get('establishment-capacity')!)?.fields;
  const normalChanges =
    capacityFields instanceof CapacityAuditFields
      ? sql`CASE WHEN audit_events.object_type='establishment-capacity'
      THEN ${capacityAuditChanges(capacityFields, sql`audit_events.changes`)} ELSE audit_events.changes END`
      : sql`audit_events.changes`;
  return {
    linkagePaths: linkage
      ? sql`CASE WHEN audit_events.object_type=${TRANSFER_LINKAGE} THEN ${linkage.paths} END`
      : sql`NULL::text[]`,
    eventChanges: linkage
      ? sql`CASE WHEN audit_events.object_type=${TRANSFER_LINKAGE} THEN ${linkage.changes}
          ELSE ${normalChanges} END`
      : normalChanges,
    dataChanges: sql`(${sql.join([...events, configPredicate(config, field)], sql` OR `)})`,
    operationLogs: sql`(${sql.join([...tasks.map((task) => task.whole), configTypes(TASK)], sql` OR `)})`,
    visibleRows: sql`(CASE WHEN ${hasItems()} THEN (SELECT COALESCE(jsonb_agg(item->'rowIndex'), '[]'::jsonb)
      FROM jsonb_array_elements(${sql.identifier(TASK)}.items) item WHERE ${rowsCase}) END)`,
    visibleCount: sql`COALESCE(${run && !run.scope.all ? orderRunCount(run, viewer) : sql`NULL::int`},
      ${orgRun ? orgAdjustmentCount(orgRun, viewer) : sql`NULL::int`})`,
    fieldsOf: (objectType, action, paths) => {
      if (objectType === TRANSFER_LINKAGE) return new ExactAuditFields(paths ?? []);
      const configured = config.get(configKey(objectType, action));
      if (configured) return configured.fields;
      if (isConfigLog(objectType, action)) return undefined;
      const rule = RULE_BY_TYPE.get(objectType);
      const fields = rule ? resolved.get(rule)?.fields : undefined;
      const drop = (action && rule?.desensitize?.byAction?.[action]) || [];
      return fields && drop.length ? new Set([...fields].filter((field) => !drop.includes(field))) : fields;
    },
  };
}

/** 脱敏出口的对象类型（DEC-340③）：不展示命令 ID、请求来源与对象编号，按这些条件筛选时一律排除。 */
export const AUDIT_DESENSITIZED_TYPES: readonly string[] = RULES.filter((rule) => rule.desensitize).flatMap(
  (rule) => rule.types,
);
export function auditDesensitized(objectType: string): boolean {
  return AUDIT_DESENSITIZED_TYPES.includes(objectType);
}

function orgAdjustmentCount(run: ResolvedRule, viewer: Viewer): SQL {
  const children = orgAdjustmentChildren(run.scope, rowOf(EVENT), viewer, run.inputs.objectFields);
  return sql`(CASE WHEN audit_events.object_type='org-adjustment-run'
    THEN (SELECT count(*)::int FROM (${children}) visible_child) END)`;
}

/** 序码重算汇总里查看人可见的逐人序码日志条数（第四轮 N4）。 */
function orderRunCount(run: ResolvedRule, viewer: Viewer): SQL {
  const children = orderCodeChildren(run.scope, rowOf(EVENT), viewer, run.inputs.objectFields);
  return sql`(CASE WHEN ${sql.identifier(EVENT)}.object_type = 'personnel-order-run'
    THEN (SELECT count(*)::int FROM (${children}) visible_child) END)`;
}

/** 对象查看字段加上规则的协议键；undefined（不限）保持不限。 */
function withProtocol(fields: ReadonlySet<string> | undefined, protocol: readonly string[] | undefined) {
  return fields === undefined || !protocol?.length ? fields : new Set([...fields, ...protocol]);
}

/** 脱敏出口的规则（DEC-340③）：查看字段去掉 hidden；不限字段时以对象全部字段为底。 */
function desensitizedFields(rule: Rule, fields: ReadonlySet<string> | undefined): ReadonlySet<string> | undefined {
  if (!rule.desensitize) return fields;
  const hidden = new Set(rule.desensitize.hidden);
  const all = fields ?? new Set(OBJECT_FIELDS.get(rule.objectCode) ?? []);
  return new Set([...all].filter((field) => !hidden.has(field)));
}

async function resolveRule(deps: Deps, ctx: TenantContext, rule: Rule): Promise<ResolvedRule | undefined> {
  const fixed = rule.fixedFields ? new Set(rule.fixedFields) : undefined;
  // 与业务接口 objectContext 同一开关：没有该对象的查看权限，审计里也看不到（第三轮 P1-3）
  const canView = () => deps.authorize({ ...ctx, action: 'object.view', resource: rule.objectCode, fields: [] });
  if (rule.resolve) {
    if (rule.objectPermission && !(await canView())) return undefined;
    const extra = await rule.resolve(deps, ctx);
    if (!extra) return undefined;
    const scope = { all: false, hasDataPermission: true } as ModuleScope;
    const objectFields = rule.objectPermission ? await getModuleViewableFields(deps, ctx, rule.objectCode) : undefined;
    const fields = fixed ?? withProtocol(objectFields, rule.protocol);
    const inputs = { extra, objectFields };
    if (rule.types.includes('survey360-person'))
      return { rule, scope, inputs, fields: survey360PersonAuditFields(fields) };
    return { rule, scope, inputs, fields: desensitizedFields(rule, fields) };
  }
  if (!(await canView())) return undefined;
  const scope = await resolveModuleScope(deps, ctx, undefined, rule.objectCode, undefined, rule.view);
  const objectFields = linkedViewable(rule.objectCode, await getModuleViewableFields(deps, ctx, rule.objectCode));
  const linkage = rule.types.includes(TRANSFER_LINKAGE)
    ? await resolveLinkageAudit(deps, ctx, scope, objectFields)
    : undefined;
  return {
    rule,
    scope,
    inputs: { extra: null, objectFields },
    fields:
      rule.types.includes('establishment-capacity') && objectFields
        ? new CapacityAuditFields(objectFields)
        : rule.objectCode === IDP_OBJECTS.goal.code
          ? await idpGoalFields(deps, ctx, objectFields)
          : (fixed ?? withProtocol(objectFields, rule.protocol)),
    ...(linkage ? { linkage } : {}),
  };
}

/**
 * 发展目标快照嵌套的任务与目标回顾按各自对象的查看权与字段裁剪（R2-2）；全部字段可见且子对象不受限时不包装。
 */
async function idpGoalFields(
  deps: Deps,
  ctx: TenantContext,
  goalFields: ReadonlySet<string> | undefined,
): Promise<ReadonlySet<string> | undefined> {
  const children: Record<string, ReadonlySet<string> | undefined | null> = {};
  for (const [key, object] of [
    ['tasks', IDP_OBJECTS.task],
    ['reviews', IDP_OBJECTS.goalReview],
  ] as const) {
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: object.code, fields: [] });
    children[key] = canView ? await getModuleViewableFields(deps, ctx, object.code) : null;
  }
  if (goalFields === undefined && Object.values(children).every((child) => child === undefined)) return undefined;
  const all = IDP_OBJECTS.goal.fields.map((field) => field.code);
  return new NestedAuditFields(goalFields ?? all, children as NestedChildren);
}

interface ResolvedConfig {
  readonly match: SQL;
  readonly fields: ReadonlySet<string> | undefined;
}

const configKey = (objectType: string, action?: string | null) =>
  action && CONFIG_FIELDS_BY_ACTION[action] ? `action:${action}` : `type:${objectType}`;

function isConfigLog(objectType: string, action?: string | null): boolean {
  return (
    AUDIT_CONFIG_OBJECT_TYPES.has(objectType) || (!!action && !!AUDIT_CONFIG_ACTIONS[objectType]?.includes(action))
  );
}

/** 解析本租户出现过的配置对象的字段权限（按对象类型或动作）。 */
async function resolveConfigFields(deps: Deps, ctx: TenantContext, present: readonly string[]) {
  const resolved = new Map<string, ResolvedConfig>();
  const t = sql.identifier(EVENT);
  const fieldsFor = async (config: ConfigFields) => {
    if (config.fixed) return new Set(config.fixed);
    const viewable = await getModuleViewableFields(deps, ctx, config.code!);
    if (viewable === undefined) return undefined;
    const presets = config.presets ? [...viewable].map((code) => `preset:${code}`) : [];
    return new Set([...viewable, ...presets, ...(config.protocol ?? [])]);
  };
  for (const [objectType, config] of Object.entries(CONFIG_FIELDS_BY_TYPE)) {
    if (!present.includes(objectType)) continue;
    resolved.set(`type:${objectType}`, {
      match: sql`${t}.object_type = ${objectType}`,
      fields: await fieldsFor(config),
    });
  }
  for (const [action, config] of Object.entries(CONFIG_FIELDS_BY_ACTION)) {
    const objectType = Object.entries(AUDIT_CONFIG_ACTIONS).find(([, actions]) => actions.includes(action))?.[0];
    if (objectType && !present.includes(objectType)) continue;
    resolved.set(`action:${action}`, { match: sql`${t}.action = ${action}`, fields: await fieldsFor(config) });
  }
  return resolved;
}

function rowOf(table: string): Row {
  const column = (name: string) => sql`${sql.identifier(table)}.${sql.identifier(name)}`;
  return {
    objectId: sql`COALESCE(${column('object_id')}, '')`,
    employee: column('scope_employee_id'),
    org: column('scope_org_id'),
    before: table === EVENT ? column('before') : sql`NULL::jsonb`,
    after: table === EVENT ? column('after') : sql`NULL::jsonb`,
    commandId: column('command_id'),
    actor: table === TASK ? column('actor_user_id') : null,
  };
}

/** 逐行归属；行里没有的取任务顶层归属（单人任务的顶层员工即每行的员工，PR #75 第五轮）。 */
function itemRow(): Row {
  const task = (name: string) => sql`${sql.identifier(TASK)}.${sql.identifier(name)}`;
  return {
    objectId: sql`COALESCE(item->>'objectId', '')`,
    employee: sql`COALESCE(NULLIF(item->>'employeeId', '')::uuid, ${task('scope_employee_id')})`,
    org: sql`COALESCE(NULLIF(item->>'orgId', '')::uuid, ${task('scope_org_id')})`,
    before: sql`NULL::jsonb`,
    after: sql`NULL::jsonb`,
    commandId: sql`${sql.identifier(TASK)}.command_id`,
    actor: sql`${sql.identifier(TASK)}.actor_user_id`,
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

function configTypes(table: string): SQL {
  return sql`${sql.identifier(table)}.object_type = ANY(${textArray([...AUDIT_CONFIG_OBJECT_TYPES])})`;
}

/**
 * DEC-203：配置类日志持日志审计即可见（不要求至少一个可见字段——没有字段权限的查看人看到操作记录本身）；
 * 字段筛选仍只匹配该配置对象可见的字段，不能借此探测隐藏字段（第四轮 N1）。
 */
function configPredicate(config: ReadonlyMap<string, ResolvedConfig>, field: string | undefined): SQL {
  const t = sql.identifier(EVENT);
  const actions = Object.entries(AUDIT_CONFIG_ACTIONS).map(
    ([type, list]) => sql`(${t}.object_type = ${type} AND ${t}.action = ANY(${textArray(list)}))`,
  );
  const isConfig = sql`(${sql.join([configTypes(EVENT), ...actions], sql` OR `)})`;
  if (field === undefined) return isConfig;
  const hidden = [...config.values()]
    .filter((entry) => entry.fields !== undefined && !fieldVisible(entry.fields, field))
    .map((entry) => entry.match);
  return hidden.length ? sql`(${isConfig} AND NOT (${sql.join(hidden, sql` OR `)}))` : isConfig;
}

/** 至少一个可见字段发生变化；带字段筛选时该字段本身也必须可见。 */
function fieldScope(fields: ReadonlySet<string> | undefined, field: string | undefined): SQL {
  if (fields === undefined) return sql`true`;
  if (field !== undefined && !fieldVisible(fields, field)) return sql`false`;
  // 派生引用字段须对同一条差异联合校验精确路径与筛选字段，不能借隐藏的 superior.name 匹配顶层 name。
  if (field !== undefined && fields instanceof ExactAuditFields)
    return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(audit_events.changes) c
      WHERE c->>'field' = ANY(${textArray([...fields])})
        AND (c->>'field'=${field} OR right(c->>'field',${field.length + 1})=${`.${field}`}))`;
  if (field !== undefined && fields instanceof CapacityAuditFields)
    return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${capacityAuditChanges(fields, sql`audit_events.changes`)}) c
      WHERE c->>'field'=${field} OR right(c->>'field',${field.length + 1})=${`.${field}`})`;
  return changedVisible(EVENT, fields);
}

/** 该日志（表或别名）至少有一个字段变化在可见字段内。 */
function changedVisible(table: string, fields: ReadonlySet<string> | undefined): SQL {
  if (fields === undefined) return sql`true`;
  if (fields instanceof ExactAuditFields)
    return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${sql.identifier(table)}.changes, '[]'::jsonb)) c
      WHERE c->>'field' = ANY(${textArray([...fields])}))`;
  const changes =
    fields instanceof CapacityAuditFields
      ? capacityAuditChanges(fields, sql`${sql.identifier(table)}.changes`)
      : sql`${sql.identifier(table)}.changes`;
  return sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${changes}, '[]'::jsonb))
      visible_change
    WHERE (CASE WHEN visible_change->>'field' LIKE 'customFields.%'
      THEN 'custom:' || substr(visible_change->>'field', 14)
      ELSE regexp_replace(visible_change->>'field', '^.*\\.', '') END) = ANY(${textArray([...fields])})
      OR visible_change->>'field' = ANY(${textArray([...fields])}))`;
}

/** 字段可见：按字段编码（路径末段）判断，或可见集合里登记了完整路径（如 changed.permission_admins）。 */
function fieldVisible(fields: ReadonlySet<string>, path: string): boolean {
  return fields.has(path) || (!(fields instanceof ExactAuditFields) && fields.has(auditFieldCode(path)));
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
  if (fields === undefined) return [...changes];
  const visible = changes.filter((change) => fieldVisible(fields, change.field));
  return fields instanceof NestedAuditFields ? visibleNestedChanges(visible, fields) : visible;
}

/** 前后值 / 快照只留可见字段；嵌套的 fields / customFields 等容器逐层裁剪，空容器去掉。 */
export function visibleValue(value: unknown, fields: ReadonlySet<string> | undefined, prefix = ''): unknown {
  if (fields === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      inner !== null &&
      typeof inner === 'object' &&
      !Array.isArray(inner) &&
      (!prefix || fields instanceof ExactAuditFields)
    ) {
      const nested = visibleValue(inner, fields, path) as Record<string, unknown>;
      if (Object.keys(nested).length) kept[key] = nested;
    } else if (fields instanceof NestedAuditFields && !prefix && key in fields.children) {
      const nested = fieldVisible(fields, path) ? visibleNested(fields, key, inner) : undefined;
      if (nested !== undefined) kept[key] = nested;
    } else if (fieldVisible(fields, path)) {
      kept[key] =
        fields instanceof CapacityAuditFields && key === 'subdivisions' ? visibleCapacityParts(inner, fields) : inner;
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
              (key === 'field' ? typeof value === 'string' && fieldVisible(fields, value) : fields.has(key)),
          ),
        )
      : entry,
  );
}
