import {
  and,
  asc,
  eq,
  onboardingMaterialItems as items,
  onboardingMaterialRules as rules,
  sql,
  type OnboardingEntryCase,
  type Tx,
} from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { recordAudit } from '../../audit/record.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCreator, employmentScopePredicate } from '../employment/context.js';
import { ENTRY_KINDS } from '../employment/employee-status.js';
import type { EntryLifecycleContext } from '../employment/onboarding-entry-port.js';
import { rowsOf } from '../employment/read-model.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
  type ModuleScope,
} from '../permission/module-access.js';
import { registerPersonScopedObject } from '../permission/scope-resolver.js';
import { lockMaterialConfig, materialDefinitions, materialRuleCoversOrg } from './material-config.js';

export const MATERIAL = MODULE_OBJECTS.onboardingMaterial.code;
registerPersonScopedObject(MATERIAL);
export const MATERIAL_STATUSES = [
  'no_materials',
  'no_required',
  'received',
  'submitted',
  'partial',
  'pending',
] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

async function materialRuleFor(tx: Tx, ctx: EntryLifecycleContext, orgId: string) {
  const candidates = await tx
    .select({ id: rules.id, revision: rules.revision, priority: rules.priority })
    .from(rules)
    .where(
      and(
        eq(rules.tenantId, ctx.tenantId),
        eq(rules.enabled, true),
        eq(rules.archived, false),
        materialRuleCoversOrg(ctx, orgId),
      ),
    )
    .orderBy(asc(rules.priority), asc(rules.id))
    .limit(2);
  const [first, second] = candidates;
  // 组织调整可使互斥规则重叠。中止当前事务，让规则修正后可按原命令重提。
  if (first && first.priority === second?.priority)
    throw new AppError('CONFLICT', '材料规则存在并列命中，请调整规则后重试', {
      reason: 'MATERIAL_RULE_AMBIGUOUS',
    });
  return first;
}

/** 与创建阶段同事务。规则改动和改期无法重写已生成的材料快照。 */
export async function generateMaterialList(tx: Tx, ctx: EntryLifecycleContext, entry: OnboardingEntryCase) {
  const { tenantId } = ctx;
  await lockMaterialConfig(tx, tenantId, false);
  const [record] = rowsOf<{ departmentId: string | null }>(
    await tx.execute(sql`SELECT department_id AS "departmentId" FROM employment_records
      WHERE tenant_id = ${tenantId} AND id = ${entry.currentBusinessId} AND employee_id = ${entry.employeeId}`),
  );
  if (!record?.departmentId) return;
  const rule = await materialRuleFor(tx, ctx, record.departmentId);
  if (!rule) return;
  const definitions = await materialDefinitions(tx, tenantId, rule.id);
  if (!definitions.length) return;
  const created = await tx
    .insert(items)
    .values(
      definitions.map(({ id, revision, name, ...flags }) => ({
        ...flags,
        tenantId,
        caseId: entry.id,
        ruleId: rule.id,
        ruleRevision: rule.revision,
        definitionId: id,
        definitionRevision: revision,
        definitionName: name,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })),
    )
    .returning();
  for (const item of created)
    await recordAudit(tx, {
      tenantId,
      actorUserId: ctx.userId,
      action: 'onboarding.material_item.create',
      objectType: 'onboarding-material-item',
      objectId: item.id,
      before: null,
      after: item,
      scope: { employeeId: entry.employeeId },
      occurredAt: ctx.now,
      commandId: ctx.commandId,
    });
}

export async function materialReadScope(tx: Tx, deps: TenantRouteDeps, ctx: TenantContext, page: string) {
  const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, MATERIAL, page);
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, MATERIAL, tx);
  return { scope, fields };
}

/** R2-T01 §4.3。材料聚合同时需要业务对象的范围和产生状态的必备、状态字段。 */
export async function materialStatusScope(tx: Tx, deps: TenantRouteDeps, ctx: TenantContext) {
  const authorize = authorizeInTransaction(deps.authorize, tx);
  if (!(await authorize({ ...ctx, action: 'object.view', resource: MATERIAL }))) return;
  const access = await materialReadScope(tx, deps, ctx, `${MATERIAL}.list`);
  if (!access.fields || (access.fields.has('required') && access.fields.has('status'))) return access.scope;
}

export function entryMaterialCaseJoin() {
  return sql`LEFT JOIN LATERAL (
    SELECT ec.id FROM onboarding_entry_cases ec
    WHERE ec.tenant_id = r.tenant_id AND ec.employee_id = r.employee_id AND ec.state <> 'deleted'
      AND (ec.current_business_id = r.id OR ec.hired_record_id = r.id)
    ORDER BY (ec.hired_record_id = r.id) DESC NULLS LAST LIMIT 1
  ) material_case ON true`;
}

export function materialEntryScope(tenantId: string, scope: ModuleScope, department: SQL) {
  return employmentScopePredicate(scope, sql`r.employee_id`, department, employmentCreator(tenantId, sql`r.id`, true));
}

/** SQL 复用同一状态表达式筛选和投影，保证隐藏行/字段无法借分页过滤观察。 */
export function materialStatusJoin(scope: ModuleScope, tenantId: string, department: SQL) {
  return sql`
    ${entryMaterialCaseJoin()}
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN count(*) = 0 THEN 'no_materials'
        WHEN count(*) FILTER (WHERE i.required) = 0 THEN 'no_required'
        WHEN bool_and(i.status = 'received') FILTER (WHERE i.required) THEN 'received'
        WHEN bool_and(i.status <> 'pending') FILTER (WHERE i.required) THEN 'submitted'
        WHEN bool_or(i.status <> 'pending') FILTER (WHERE i.required) THEN 'partial'
        ELSE 'pending'
      END AS status
      FROM onboarding_material_items i
      WHERE i.tenant_id = r.tenant_id AND i.case_id = material_case.id
    ) material_summary ON ${materialEntryScope(tenantId, scope, department)}
  `;
}

export async function readMaterialList(
  tx: Tx,
  ctx: TenantContext,
  businessId: string,
  entryScope: ModuleScope,
  access: Awaited<ReturnType<typeof materialReadScope>>,
  page: { limit: number; offset: number },
) {
  const department = sql`COALESCE(snap.department_id, r.department_id)`;
  const [entry] = rowsOf<{ caseId: string | null }>(
    await tx.execute(sql`SELECT material_case.id AS "caseId" FROM employment_records r
      JOIN employment_timeline t ON t.tenant_id = r.tenant_id AND t.record_id = r.id
      LEFT JOIN LATERAL (SELECT p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id = r.tenant_id AND p.business_id = r.id AND p.is_record_snapshot
        ORDER BY p.version_no DESC LIMIT 1) snap ON true
      ${entryMaterialCaseJoin()}
      WHERE r.tenant_id = ${ctx.tenantId} AND r.id = ${businessId}
        AND r.kind IN (${sql.join(
          ENTRY_KINDS.map((kind) => sql`${kind}`),
          sql`, `,
        )})
        AND ${materialEntryScope(ctx.tenantId, entryScope, department)}
        AND ${materialEntryScope(ctx.tenantId, access.scope, department)}`),
  );
  if (!entry) throw new AppError('NOT_FOUND', '待入职材料清单不存在');
  if (!entry.caseId) return { items: [] };
  const rows = await tx
    .select({
      id: items.id,
      revision: items.revision,
      definitionId: items.definitionId,
      definitionName: items.definitionName,
      status: items.status,
      required: items.required,
      allowSupplement: items.allowSupplement,
      submittedAt: items.submittedAt,
      receivedAt: items.receivedAt,
      createdAt: items.createdAt,
      createdBy: items.createdBy,
      updatedAt: items.updatedAt,
    })
    .from(items)
    .where(and(eq(items.tenantId, ctx.tenantId), eq(items.caseId, entry.caseId)))
    .orderBy(asc(items.position), asc(items.id))
    .limit(page.limit)
    .offset(page.offset);
  return {
    items: rows.map(({ definitionName, ...row }) => {
      const visible = Object.fromEntries(
        Object.entries(row).filter(([key]) => !access.fields || access.fields.has(key)),
      );
      // 冻结名称是 definitionId 的展示标签，随该引用一并授权。
      return Object.hasOwn(visible, 'definitionId') ? { ...visible, definitionName } : visible;
    }),
  };
}
