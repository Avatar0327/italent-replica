/**
 * F-023：只在读取时展开历史联动快照；不改写审计、归属触发器或历史 changes。
 * 合同与 #74 foreignVisibility 相同：对象查看权 + 目标合同员工/创建人范围 + 合同字段权。
 * 联动保存的职责数组整体裁剪；子项目标不可见时整条隐藏，避免失败消息暴露目标信息（DEC-197）。
 */
import { sql } from '@italent/db';
import { buttonResource, CONTRACT_OBJECT, MODULE_OBJECTS, tenantLocalDate } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { TenantRouteDeps } from '../routes.js';
import type { TenantContext } from '../tenant-context.js';
import { employmentCreator } from '../modules/employment/context.js';
import { employmentVisibilitySql } from '../modules/employment/visibility.js';
import {
  getModuleViewableFields,
  resolveModuleScope,
  scopeSql,
  type ModuleScope,
} from '../modules/permission/module-access.js';
import { currentPersons } from '../modules/permission/scope-persons.js';
import { creatorSql } from '../modules/permission/scope-audit.js';
import { RELATION_FIELDS, ROLE_FIELDS } from '../modules/transfer/linkage/validation.js';

export const TRANSFER_LINKAGE = 'transfer-linkage';
const EMP = MODULE_OBJECTS.employmentRecord.code;
const ORG = MODULE_OBJECTS.organization.code;
const event = sql`audit_events`;
const idOf = (value: SQL) => sql`(CASE WHEN audit_is_uuid(${value}) THEN (${value})::uuid END)`;
const object = (value: SQL) => sql`(CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${value} ELSE '{}'::jsonb END)`;
const array = (value: SQL) => sql`(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END)`;
const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/** 完整路径集合，不允许任职的同名末段字段放行合同字段。 */
export class ExactAuditFields extends Set<string> {}

export function transferEmployee(tenantId: string, objectId: SQL): SQL {
  return sql`(SELECT b.employee_id FROM employment_business_objects b
    JOIN employment_employees e ON e.tenant_id=b.tenant_id AND e.id=b.employee_id
    WHERE b.tenant_id=${tenantId} AND b.id=${idOf(objectId)}
      AND EXISTS (SELECT 1 FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id AND p.kind='transfer'))`;
}

interface ObjectAccess {
  readonly view: boolean;
  readonly scope: ModuleScope;
  readonly fields: ReadonlySet<string> | undefined;
}
interface LinkageAccess {
  readonly tenantId: string;
  readonly today: string;
  readonly employment: ObjectAccess;
  readonly contract: ObjectAccess;
  readonly organization: ObjectAccess;
  readonly hr: boolean;
}
export interface LinkageAudit {
  readonly visible: SQL;
  readonly paths: SQL;
  readonly changes: SQL;
  matches(field?: string): SQL;
}

export async function resolveLinkageAudit(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  scope: ModuleScope,
  fields: ReadonlySet<string> | undefined,
): Promise<LinkageAudit> {
  const access: LinkageAccess = {
    tenantId: ctx.tenantId,
    today: tenantLocalDate(deps.clock(), ctx.timezone),
    employment: { view: true, scope, fields },
    contract: await objectAccess(deps, ctx, CONTRACT_OBJECT),
    organization: await objectAccess(deps, ctx, ORG),
    // 同调动 HR 入口，不凭管理员身份推定业务权；仍须范围与 adjustSalary 查看权。
    hr: await deps.authorize({
      ...ctx,
      action: 'object.button',
      resource: buttonResource(EMP, 'Transfer.Hr', 'detail'),
    }),
  };
  const paths = sql`(${leaves()} SELECT COALESCE(array_agg(path), ARRAY[]::text[]) FROM leaf
    WHERE ${pathVisible(access)})`;
  const changes = sql`(${leaves()} SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'field',path,'from',old_value,'to',new_value) ORDER BY path), '[]'::jsonb)
    FROM leaf WHERE ${different()})`;
  return {
    paths,
    changes,
    visible: eventVisible(access),
    matches: (field) => sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${changes}) change
      WHERE change->>'field' = ANY(${paths}::text[]) AND ${fieldMatch(field)})`,
  };
}

async function objectAccess(deps: TenantRouteDeps, ctx: TenantContext, code: string): Promise<ObjectAccess> {
  return {
    view: await deps.authorize({ ...ctx, action: 'object.view', resource: code }),
    scope: await resolveModuleScope(deps, ctx, undefined, code, `${code}.list`),
    fields: await getModuleViewableFields(deps, ctx, code),
  };
}

/** SQL / 快照共用完整路径；递归展开 contract.fields.customFields，数组作为一个业务字段保留。 */
function leaves(): SQL {
  return sql`WITH RECURSIVE tree(path, old_value, new_value) AS (
    SELECT ''::text, ${event}.before, ${event}.after
    UNION ALL
    SELECT CASE WHEN path='' THEN k.key ELSE path || '.' || k.key END,
      tree.old_value->k.key, tree.new_value->k.key
    FROM tree CROSS JOIN LATERAL jsonb_object_keys(${object(sql`old_value`)} || ${object(sql`new_value`)}) k(key)
  ), leaf AS (
    SELECT path, COALESCE(old_value,'null'::jsonb) AS old_value, COALESCE(new_value,'null'::jsonb) AS new_value
    FROM tree WHERE path<>'' AND jsonb_typeof(old_value) IS DISTINCT FROM 'object'
      AND jsonb_typeof(new_value) IS DISTINCT FROM 'object'
  )`;
}

const different = () => sql`old_value IS DISTINCT FROM new_value
  AND NOT (old_value IN ('null'::jsonb, '""'::jsonb) AND new_value IN ('null'::jsonb, '""'::jsonb))`;
function fieldMatch(field: string | undefined): SQL {
  return field === undefined
    ? sql`true`
    : sql`(change->>'field'=${field}
    OR right(change->>'field', ${field.length + 1})=${`.${field}`})`;
}
const can = (access: ObjectAccess, field: string) => access.view && (!access.fields || access.fields.has(field));

function eventVisible(a: LinkageAccess): SQL {
  const salary = a.hr && can(a.employment, 'adjustSalary');
  const item = sql`EXISTS (SELECT 1 FROM transfer_linkage_items li
    WHERE li.tenant_id=${a.tenantId} AND li.business_id=${idOf(sql`${event}.object_id`)}
      AND li.id=${idOf(sql`${event}.after->>'itemId'`)}
      AND li.item_type=${event}.after->>'itemType' AND ${itemVisible(a)})`;
  return sql`(CASE
    WHEN ${event}.action='transfer.linkage.salary_reminder' THEN ${salary}
    WHEN ${event}.action LIKE 'transfer.linkage.item.%' THEN ${item}
    ELSE ${event}.action IN ('transfer.linkage.save','transfer.linkage.executed') END)`;
}

function itemVisible(a: LinkageAccess): SQL {
  return sql`(CASE li.item_type
    WHEN 'duty_subordinate' THEN ${can(a.employment, 'dutyTransfer')}
      AND ${subordinateVisible(a, sql`li.subordinate_id`, sql`li.relation`)}
    WHEN 'duty_org_role' THEN ${can(a.employment, 'dutyTransfer')}
      AND ${organizationVisible(a, sql`li.org_id`, sql`li.org_role`)}
    WHEN 'part_time_end' THEN ${can(a.employment, 'partTimeEnds')}
    ELSE false END)`;
}

function mappedField(access: ObjectAccess, value: SQL, mapping: Readonly<Record<string, string>>): SQL {
  const allowed = Object.entries(mapping)
    .filter(([, field]) => can(access, field))
    .map(([key]) => key);
  return sql`${value} = ANY(${textArray(allowed)})`;
}

function subordinateVisible(a: LinkageAccess, employee: SQL, relation: SQL): SQL {
  const visible = employmentVisibilitySql(a.employment.scope, {
    employee: sql`r.employee_id`,
    department: sql`p.department_id`,
    creator: employmentCreator(a.tenantId, sql`r.id`, true),
  });
  return sql`(${mappedField(a.employment, relation, RELATION_FIELDS)} AND EXISTS (
    SELECT 1 FROM employment_timeline t
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    JOIN (${currentPersons(a.tenantId, a.today)}) p
      ON p.employee_id=r.employee_id AND p.service_type=r.service_type
    WHERE t.tenant_id=${a.tenantId} AND t.employee_id=${employee} AND t.valid_during @> ${a.today}::date
      AND ${visible}))`;
}

function organizationVisible(a: LinkageAccess, org: SQL, role: SQL): SQL {
  return sql`(${mappedField(a.organization, role, ROLE_FIELDS)} AND EXISTS (
    SELECT 1 FROM org_objects o WHERE o.tenant_id=${a.tenantId} AND o.id=${org}
    AND ${scopeSql(a.organization.scope, {
      org: sql`o.id`,
      creator: creatorSql(a.tenantId, sql`o.id`, 'org.create', 'organization'),
    })}))`;
}

/** 数组不可部分披露或保留汇总数量：任何目标无权就隐藏整个数组，子项事件另行逐条授权。 */
function dutiesVisible(a: LinkageAccess, kind: 'subordinates' | 'orgRoles'): SQL {
  const before = sql`${event}.before->'dutyTransfer'->${kind}`;
  const after = sql`${event}.after->'dutyTransfer'->${kind}`;
  const visible =
    kind === 'subordinates'
      ? subordinateVisible(a, idOf(sql`d->>'employeeId'`), sql`d->>'relation'`)
      : organizationVisible(a, idOf(sql`d->>'orgId'`), sql`d->>'role'`);
  return sql`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${array(before)} || ${array(after)}) d
    WHERE NOT COALESCE(${visible}, false))`;
}

/** 新旧合同目标都按各自创建人判定，不能拿新目标的权限读取旧目标值。 */
function contractsVisible(a: LinkageAccess): SQL {
  const snapshots = sql`jsonb_build_array(${event}.before->'contract', ${event}.after->'contract')`;
  const visible = employmentVisibilitySql(a.contract.scope, {
    employee: sql`c.employee_id`,
    department: sql`NULL::uuid`,
    creator: sql`c.created_by`,
  });
  return sql`(${a.contract.view} AND EXISTS (SELECT 1 FROM jsonb_array_elements(${snapshots}) s
      WHERE jsonb_typeof(s)='object')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${snapshots}) s
      CROSS JOIN LATERAL (SELECT s->>'targetId' AS id UNION ALL SELECT s->>'beforeContractId'
        UNION ALL SELECT s->>'afterContractId') target
      WHERE target.id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM contract_records c
        JOIN employment_employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id
        WHERE c.tenant_id=${a.tenantId} AND c.id=${idOf(sql`target.id`)}
          AND c.employee_id=${transferEmployee(a.tenantId, sql`${event}.object_id`)} AND ${visible}))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${snapshots}) s
      WHERE jsonb_typeof(s)='object'
        AND COALESCE(s->>'targetId',s->>'beforeContractId',s->>'afterContractId') IS NULL))`;
}

const OWN_FIELDS: Readonly<Record<string, string>> = {
  adjustSalary: 'adjustSalary',
  'onTrial.startDate': 'onTrialStartDate',
  'onTrial.months': 'onTrialMonths',
  'handover.handoverPersonId': 'handoverPersonId',
  partTimes: 'partTimeEnds',
  effectiveDate: 'effectiveDate',
  plannedEffectiveDate: 'effectiveDate',
};
function pathVisible(a: LinkageAccess): SQL {
  const own = Object.entries(OWN_FIELDS)
    .filter(([, field]) => can(a.employment, field))
    .map(([path]) => path);
  const contractField = sql`(CASE
    WHEN path IN ('contract.targetId','contract.beforeContractId','contract.afterContractId') THEN 'id'
    WHEN path LIKE 'contract.fields.customFields.%' THEN 'custom:' || substr(path, 30)
    WHEN path LIKE 'contract.fields.%' THEN substr(path, 17) ELSE NULL END)`;
  const contractFields =
    a.contract.fields === undefined ? sql`true` : sql`${contractField} = ANY(${textArray([...a.contract.fields])})`;
  // 子项整条已通过目标范围与对应字段判定；仅展示写入端的协议字段。
  const itemPaths = ['itemId', 'itemType', 'status', 'attemptCount', 'failure.code', 'failure.message', 'failure.rule'];
  return sql`(CASE
    WHEN ${event}.action='transfer.linkage.salary_reminder'
      THEN ${a.hr && can(a.employment, 'adjustSalary')}
        AND path=ANY(${textArray(['title', 'audience', 'effectiveDate'])})
    WHEN ${event}.action LIKE 'transfer.linkage.item.%' THEN path=ANY(${textArray(itemPaths)})
    WHEN path LIKE 'contract.%' THEN ${contractField} IS NOT NULL AND ${contractFields} AND ${contractsVisible(a)}
    WHEN path='dutyTransfer.subordinates' THEN ${can(a.employment, 'dutyTransfer')}
      AND ${dutiesVisible(a, 'subordinates')}
    WHEN path='dutyTransfer.orgRoles' THEN ${can(a.employment, 'dutyTransfer')}
      AND ${dutiesVisible(a, 'orgRoles')}
    WHEN path='contract' THEN ${can(a.employment, 'isChangeContract')}
    WHEN path='onTrial' THEN ${can(a.employment, 'onTrialMonths') && can(a.employment, 'onTrialStartDate')}
    WHEN path='handover' THEN ${can(a.employment, 'handoverPersonId')}
    WHEN path='dutyTransfer' THEN ${can(a.employment, 'dutyTransfer')}
    ELSE path=ANY(${textArray(own)}) END)`;
}
