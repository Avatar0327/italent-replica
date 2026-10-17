/**
 * BE-7 PT-3a 服务层验收的共用夹具（docs/08_设计/R2-T05_兼职设计.md §13.2）：在 AC-PT-support 的任职会话之上，
 * 经内部服务 createPartTime 写兼职（PT-3a 没有公开入口）、经真实任职入口落地离职、可信造数在途离职与停用组织。
 * 兼职写入一律放进对应租户的 withTenant（F-212，普通角色 + FORCE RLS）。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { AppError } from '../../apps/api/src/errors.js';
import { createPartTime, type CreatePartTimeInput } from '../../apps/api/src/modules/employment/part-time/service.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { partTimeWorld } from './AC-PT-support.js';
import { tenantApi } from './support/tenant-api.js';

export type PartTimeCreate = Partial<CreatePartTimeInput>;

export async function serviceWorld(db: Db, label: string) {
  const w = await partTimeWorld(db, label);

  const input = (patch: PartTimeCreate): CreatePartTimeInput => ({
    employeeId: w.employeeId,
    serviceType: 'part_time',
    startDate: '2026-09-01',
    departmentId: w.partTimeOrg.id,
    ...patch,
  });
  /** 内部服务 createPartTime：自己的租户事务（成功提交，失败回滚）。 */
  const create = (patch: PartTimeCreate = {}, context: EmploymentContext = w.context()) =>
    withTenant(db, w.tenantId, (tx) => createPartTime(tx, context, input(patch)));
  /** 预期被拒绝：返回 AppError（成功则抛错）。 */
  async function rejection(patch: PartTimeCreate = {}, context: EmploymentContext = w.context()): Promise<AppError> {
    try {
      await create(patch, context);
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
    throw new Error('预期被拒绝，但兼职创建成功了');
  }
  const reason = (error: AppError) => (error.details as { reason?: string } | undefined)?.reason;

  const terms = (recordId: string) =>
    withTenant(db, w.tenantId, async (tx) =>
      rowsOf<{ term_no: number; end_date: string | null; source: string; source_id: string | null }>(
        await tx.execute(sql`SELECT term_no, end_date::text, source, source_id::text FROM employment_part_time_terms
          WHERE tenant_id = ${w.tenantId} AND record_id = ${recordId} ORDER BY term_no`),
      ),
    );
  const headRevision = (recordId: string) =>
    withTenant(db, w.tenantId, async (tx) => {
      const [row] = rowsOf<{ revision: number }>(
        await tx.execute(sql`SELECT revision FROM employment_business_objects
          WHERE tenant_id = ${w.tenantId} AND id = ${recordId}`),
      );
      return row!.revision;
    });

  /** 经真实任职入口办理直接离职并落地（可信端口 seed，状态钩子随之触发）；返回离职业务（id = 离职记录 ID）。 */
  async function leave(lastWorkDate: string) {
    const employee = await w.getEmployee(w.employeeId);
    return w.business(w.employeeId, { kind: 'leave', mode: 'direct', lastWorkDate }, employee.revision);
  }

  /** 可信造数一条审批中 / 已批未落地的离职（R2-T03 的门禁入口 B3-3 之前不落地，§4.3A F3）。生效日 = 最后工作日次日。 */
  async function pendingExit(lastWorkDate: string, state: 'draft' | 'in_review' | 'approved' = 'in_review') {
    const id = randomUUID();
    const payload = randomUUID();
    const effective = new Date(`${lastWorkDate}T00:00:00Z`);
    effective.setUTCDate(effective.getUTCDate() + 1);
    const effectiveDate = effective.toISOString().slice(0, 10);
    await withTenant(db, w.tenantId, async (tx: Tx) => {
      await tx.execute(sql`INSERT INTO employment_business_objects(id, tenant_id, employee_id)
        VALUES (${id}, ${w.tenantId}, ${w.employeeId})`);
      await tx.execute(sql`INSERT INTO employment_payload_versions(id, tenant_id, employee_id, business_id, version_no,
          kind, mode, effective_date, last_work_date, form_id, selected_staff_id)
        VALUES (${payload}, ${w.tenantId}, ${w.employeeId}, ${id}, 1, 'leave', 'application', ${effectiveDate},
          ${lastWorkDate}, 'leave', ${w.cycle.id})`);
      const chain = ['draft', 'in_review', 'approved'].slice(0, ['draft', 'in_review', 'approved'].indexOf(state) + 1);
      for (const [index, value] of chain.entries())
        await tx.execute(sql`INSERT INTO employment_state_events(tenant_id, employee_id, business_id,
            payload_version_id, state, event_no, command_id)
          VALUES (${w.tenantId}, ${w.employeeId}, ${id}, ${payload}, ${value}, ${index + 1},
            ${`pt-exit-${id}-${index}`})`);
    });
    return { id, effectiveDate };
  }

  /** 组织自 effectiveDate 起停用（真实组织入口，租户根下无人员即可）。 */
  async function disableOrg(org: { id: string; revision: number }, effectiveDate: string) {
    const api = tenantApi(db, { clock: () => new Date(`${effectiveDate}T01:00:00Z`) });
    return api.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
      tenant: w.tenantId,
      user: w.user.id,
      ifMatch: org.revision,
      body: { enabled: false, effectiveDate },
    });
  }

  /** 可信造数一条记录快照载荷（PT-3c 编辑兼职的落点，§1.3）：把兼职记录当前部门改到 departmentId。 */
  const moveSnapshot = (recordId: string, departmentId: string) =>
    withTenant(db, w.tenantId, async (tx) => {
      const [last] = rowsOf<{ id: string; version_no: number; effective_date: string; selected_staff_id: string }>(
        await tx.execute(sql`SELECT id, version_no, effective_date::text, selected_staff_id
          FROM employment_payload_versions WHERE tenant_id=${w.tenantId} AND business_id=${recordId}
          ORDER BY version_no DESC LIMIT 1`),
      );
      await tx.execute(sql`INSERT INTO employment_payload_versions(tenant_id, employee_id, business_id, version_no,
          previous_version_id, command_id, trigger_business_id, kind, mode, effective_date, form_id, selected_staff_id,
          is_record_snapshot, department_id)
        VALUES (${w.tenantId}, ${w.employeeId}, ${recordId}, ${last!.version_no + 1}, ${last!.id}, ${randomUUID()},
          ${recordId}, 'part_time', 'direct', ${last!.effective_date}, 'part_time', ${last!.selected_staff_id}, true,
          ${departmentId})`);
    });

  /** 兼职相关表与审计的写入指纹：被拒后逐项相等 = 无写入。 */
  const writes = () =>
    withTenant(db, w.tenantId, async (tx) => {
      const [row] = rowsOf<Record<string, unknown>>(
        await tx.execute(sql`SELECT
          (SELECT count(*)::int FROM employment_records WHERE tenant_id=${w.tenantId}) AS records,
          (SELECT count(*)::int FROM employment_part_time_terms WHERE tenant_id=${w.tenantId}) AS terms,
          (SELECT count(*)::int FROM employment_business_objects WHERE tenant_id=${w.tenantId}) AS heads,
          (SELECT count(*)::int FROM audit_events WHERE tenant_id=${w.tenantId}) AS audits,
          (SELECT count(*)::int FROM employment_outbox WHERE tenant_id=${w.tenantId}) AS outbox`),
      );
      return row;
    });

  return { ...w, create, rejection, reason, terms, headRevision, leave, pendingExit, disableOrg, moveSnapshot, writes };
}

export type ServiceWorld = Awaited<ReturnType<typeof serviceWorld>>;
