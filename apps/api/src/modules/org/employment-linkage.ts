/** DEC-137：按组织变更生效日的行政树和已生效任职选人；同事务、有界、整体成功或失败。 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { pendingActivationState } from '../employment/activation-store.js';
import { auditEmployment, employmentCreator, requireLinkedEmploymentRecord } from '../employment/context.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import { appendOrgAdjustment } from '../employment/org-adjustment.js';
import { rowsOf } from '../employment/record-store.js';
import type { EmploymentContext } from '../employment/types.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import type { OrgRecord } from './read-model.js';
import { invalid, type OrganizationPatch } from './validation.js';

export const ORG_EMPLOYMENT_LIMIT = 1000;
const idsSql = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

export function requiresEmploymentChoice(current: OrgRecord, patch: OrganizationPatch): boolean {
  return (
    (patch.name !== undefined && patch.name.trim() !== current.name) ||
    (patch.parents?.admin !== undefined &&
      patch.parents.admin.parentId.toLowerCase() !== current.parents.admin?.parentId)
  );
}

export function validateEmploymentChoice(current: OrgRecord, patch: OrganizationPatch): boolean {
  const required = requiresEmploymentChoice(current, patch);
  if (required && typeof patch.addEmployment !== 'boolean')
    throw invalid('addEmployment', '改名或改行政上级时必须选择是否新增任职');
  if (!required && patch.addEmployment !== undefined)
    throw invalid('addEmployment', '只有改名或改行政上级时才能选择是否新增任职');
  return required && patch.addEmployment === true;
}

/** 单个 SQL 快照内选中生效日的整支行政树，不随当前树误选；最新任职字段快照含后续更正。 */
function subtree(tenantId: string, orgId: string | readonly string[], date: string) {
  return sql`WITH RECURSIVE versions AS (
    SELECT DISTINCT ON (org_id) id,org_id FROM org_versions
    WHERE tenant_id=${tenantId} AND start_date<=${date}::date ORDER BY org_id,start_date DESC,version_no DESC
  ), tree AS (
    SELECT org_id FROM versions WHERE org_id=ANY(${idsSql(typeof orgId === 'string' ? [orgId] : orgId)})
    UNION
    SELECT v.org_id FROM tree t JOIN org_hierarchy_links h ON h.tenant_id=${tenantId}
      AND h.dimension='admin' AND h.parent_org_id=t.org_id JOIN versions v ON v.id=h.version_id
  )`;
}

export async function orgEmploymentTargets(
  tx: Tx,
  ctx: EmploymentContext,
  orgId: string | readonly string[],
  date: string,
) {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
    ${subtree(ctx.tenantId, orgId, date)}
    SELECT e.id FROM employment_employees e
    JOIN employment_timeline t ON t.tenant_id=e.tenant_id AND t.employee_id=e.id AND t.valid_during @> ${date}::date
    JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT id,department_id FROM employment_payload_versions p
      WHERE p.tenant_id=r.tenant_id AND p.business_id=r.id AND p.is_record_snapshot
      ORDER BY version_no DESC LIMIT 1) p ON true
    WHERE e.tenant_id=${ctx.tenantId} AND r.kind NOT IN ('leave','retirement') AND r.service_type='primary'
      AND (CASE WHEN p.id IS NULL THEN r.department_id ELSE p.department_id END) IN (SELECT org_id FROM tree)
    ORDER BY e.id LIMIT ${ORG_EMPLOYMENT_LIMIT + 1}
  `),
  );
  if (rows.length > ORG_EMPLOYMENT_LIMIT) throw new AppError('PAYLOAD_TOO_LARGE', '组织联动任职超过单次处理上限');
  return rows.map((row) => row.id);
}

/** F-008：全部员工按 UUID 在组织设置/对象和业务锁之前取锁；等待期间集合变化则整单 409，不能补锁倒序。 */
export interface OrgEmploymentBatch {
  readonly employeeIds: ReadonlySet<string>;
  remaining: number;
}

export async function lockOrgEmploymentEmployees(tx: Tx, ctx: EmploymentContext, ids: readonly string[]) {
  if (ids.length)
    await tx.execute(sql`SELECT id FROM employment_employees
    WHERE tenant_id=${ctx.tenantId} AND id=ANY(${idsSql(ids)}) ORDER BY id FOR NO KEY UPDATE`);
}

export async function lockOrgEmploymentTargets(
  tx: Tx,
  ctx: EmploymentContext,
  orgId: string,
  date: string,
  batch?: OrgEmploymentBatch,
) {
  const ids = await orgEmploymentTargets(tx, ctx, orgId, date);
  if (batch) {
    if (ids.some((id) => !batch.employeeIds.has(id)))
      throw new AppError('CONFLICT', '组织联动人员已变化，请刷新后显式重提', { reason: 'ORG_EMPLOYMENT_PLAN_CHANGED' });
    if (ids.length > batch.remaining) throw new AppError('PAYLOAD_TOO_LARGE', '整批组织联动任职超过单次处理上限');
    batch.remaining -= ids.length;
  } else await lockOrgEmploymentEmployees(tx, ctx, ids);
  return ids;
}

export async function applyOrgEmploymentLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  orgId: string,
  date: string,
  locked: readonly string[],
) {
  // 组织设置锁串行行政树变更；员工锁串行任职、审批及迟到调动。集合不一致时回滚组织新版本。
  const current = await orgEmploymentTargets(tx, ctx, orgId, date);
  if (current.length !== locked.length || current.some((id, index) => id !== locked[index]))
    throw new AppError('CONFLICT', '组织联动人员已变化，请刷新后显式重提', { reason: 'ORG_EMPLOYMENT_PLAN_CHANGED' });
  for (const employeeId of current) await appendOrgAdjustment(tx, ctx, employeeId, date);
  await auditEmployment(tx, ctx, 'org.employment.adjusted', 'organization', orgId, null, {
    effectiveDate: date,
    employeeCount: current.length,
  });
}

/** 只返回可见记录是否存在，不泄露姓名/工号/记录标识；迟到且未生效的业务同样提示。 */
export async function hasPendingOrgEmployment(tx: Tx, ctx: EmploymentContext, orgId: string, date: string) {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const rows = rowsOf(
    await tx.execute(sql`
    ${subtree(ctx.tenantId, orgId, date)}
    SELECT 1 FROM employment_business_objects b
    JOIN LATERAL (SELECT * FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    JOIN LATERAL (SELECT state FROM employment_state_events s WHERE s.tenant_id=b.tenant_id AND s.business_id=b.id
      ORDER BY event_no DESC LIMIT 1) s ON true
    LEFT JOIN employment_timeline t ON t.tenant_id=b.tenant_id AND t.employee_id=b.employee_id
      AND t.valid_during @> ${today}::date
    LEFT JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
    LEFT JOIN LATERAL (SELECT id,department_id FROM employment_payload_versions current_payload
      WHERE current_payload.tenant_id=r.tenant_id AND current_payload.business_id=r.id
        AND current_payload.is_record_snapshot ORDER BY version_no DESC LIMIT 1) current_payload ON true
    WHERE b.tenant_id=${ctx.tenantId} AND p.effective_date<${date}::date
      AND (s.state IN ('draft','in_review','approved','rejected')
        OR (s.state='effective' AND (p.effective_date>${today}::date OR ${pendingActivationState(ctx.timezone)})))
      AND (p.department_id IN (SELECT org_id FROM tree)
        OR (CASE WHEN current_payload.id IS NULL THEN r.department_id ELSE current_payload.department_id END)
          IN (SELECT org_id FROM tree))
      AND ${employmentVisibilitySql(ctx.scope, {
        employee: sql`b.employee_id`,
        department: sql`p.department_id`,
        creator: employmentCreator(ctx.tenantId, sql`b.id`, true),
      })}
    LIMIT 1
  `),
  );
  return rows.length > 0;
}

/** 原命令重放仍按当前可见性复核整个联动足迹，撤权不能通过幂等回执绕过 DEC-178。 */
export async function authorizeOrgEmploymentReplay(tx: Tx, ctx: EmploymentContext) {
  const targets = rowsOf<{ id: string }>(
    await tx.execute(sql`
    SELECT DISTINCT object_id AS id FROM employment_outbox
    WHERE tenant_id=${ctx.tenantId} AND command_id=${ctx.commandId}
      AND object_type='employment-record' LIMIT ${ORG_EMPLOYMENT_LIMIT * 2 + 1}
  `),
  );
  if (targets.length > ORG_EMPLOYMENT_LIMIT * 2) throw new AppError('PAYLOAD_TOO_LARGE', '组织联动足迹超过上限');
  for (const target of targets) {
    const record = await loadEmploymentRecord(tx, ctx.tenantId, target.id, tenantLocalDate(ctx.now, ctx.timezone));
    if (!record) throw new AppError('LINKED_RECORD_OUT_OF_SCOPE', '联动记录不可用');
    await requireLinkedEmploymentRecord(tx, ctx, record.employeeId, record.fields.departmentId, record.id);
  }
}
