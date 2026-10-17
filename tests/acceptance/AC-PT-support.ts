/**
 * BE-7 兼职验收测试的共用夹具（docs/08_设计/R2-T05_兼职设计.md §13.2：可信造数放这里，packages/testkit 不放业务造数）。
 * PT-1 只有表与约束、没有写入口：在租户事务（app_user + RLS）里直接插底层业务头 + 载荷 + 状态事件 + 记录（§1.3），
 * 不写时间轴；期限链与申请表同样用 SQL。只依赖 main 已有的导出，表或约束缺失时是断言失败而不是导入错误。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { findCurrentRecord, listEmploymentRecords } from '../../apps/api/src/modules/employment/read-model.js';
import { employmentSession, EMP_TODAY } from './AC-EMP-support.js';
import { uniqueSuffix } from './support/unique.js';

const ENTRY = '2025-01-01';

export interface PartTimeInput {
  readonly serviceType?: string;
  readonly kind?: string;
  readonly startDate?: string;
  readonly endDate?: string | null;
}

/** 错误转成“SQLSTATE 错误文本”，便于同时断言错误码与约束名。 */
export function failure(error: unknown) {
  const cause = (error as { cause?: { code?: string } }).cause ?? error;
  return `${(cause as { code?: string }).code ?? ''} ${String(cause)}`;
}

export async function partTimeWorld(db: Db, label: string) {
  const session = await employmentSession(db, `pt-${label}`);
  const tenantId = session.tenant.id;
  const primary = await session.org(`主职部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
  const partTimeOrg = await session.org(`兼职部门${uniqueSuffix()}`, { establishedOn: '2024-01-01' });
  const created = await session.employee('兼职员工');
  await session.business(
    created.id,
    { kind: 'hire', mode: 'direct', effectiveDate: ENTRY, fields: { departmentId: primary.id } },
    created.revision,
  );
  const employeeId = created.id;
  const [cycle] = await withTenant(db, tenantId, async (tx) =>
    rowsOf<{ id: string; entry_date: string }>(
      await tx.execute(sql`SELECT id, entry_date::text FROM employment_cycles
        WHERE tenant_id = ${tenantId} AND employee_id = ${employeeId}`),
    ),
  );

  /** 在租户事务里执行：成功返回 undefined，失败返回“SQLSTATE 错误文本”（只回滚这个事务）。 */
  async function attempt(work: (tx: Tx) => Promise<unknown>, tenant = tenantId) {
    try {
      await withTenant(db, tenant, work);
      return undefined;
    } catch (error) {
      return failure(error);
    }
  }

  /** 迁移属主（不切 app_user）执行：用来证明只追加触发器本身拒绝，而不只是列权限拒绝。 */
  async function asOwner(statement: ReturnType<typeof sql>) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
        await tx.execute(statement);
      });
      return undefined;
    } catch (error) {
      return failure(error);
    }
  }

  /** 可信造数一条兼职记录（底层业务头与记录同 ID，§1.3），不写时间轴；返回记录 ID。 */
  async function insertPartTime(tx: Tx, input: PartTimeInput = {}) {
    const id = randomUUID();
    const payload = randomUUID();
    const kind = input.kind ?? 'part_time';
    const start = input.startDate ?? '2026-09-01';
    await tx.execute(sql`INSERT INTO employment_business_objects(id, tenant_id, employee_id)
      VALUES (${id}, ${tenantId}, ${employeeId})`);
    await tx.execute(sql`INSERT INTO employment_payload_versions(id, tenant_id, employee_id, business_id, version_no,
        kind, mode, effective_date, form_id, selected_staff_id, department_id)
      VALUES (${payload}, ${tenantId}, ${employeeId}, ${id}, 1, ${kind}, 'direct', ${start}, 'part_time',
        ${cycle!.id}, ${partTimeOrg.id})`);
    await tx.execute(sql`INSERT INTO employment_state_events(tenant_id, employee_id, business_id, payload_version_id,
        state, event_no, command_id)
      VALUES (${tenantId}, ${employeeId}, ${id}, ${payload}, 'effective', 1, ${`pt-seed-${id}`})`);
    await tx.execute(sql`INSERT INTO employment_records(id, tenant_id, employee_id, payload_version_id, staff_id,
        entry_date, kind, start_date, service_type, department_id, employ_type)
      VALUES (${id}, ${tenantId}, ${employeeId}, ${payload}, ${cycle!.id}, ${cycle!.entry_date}, ${kind}, ${start},
        ${input.serviceType ?? 'part_time'}, ${partTimeOrg.id}, 'internal')`);
    return id;
  }

  const term = (recordId: string, termNo: number, endDate: string | null, source: string) =>
    sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date, source, command_id)
      VALUES (${tenantId}, ${employeeId}, ${recordId}, ${termNo}, ${endDate}, ${source}, ${`pt-term-${randomUUID()}`})`;

  /** 主职读口径（时间轴）：当前记录与全部记录。 */
  const primaryView = () =>
    withTenant(db, tenantId, async (tx) => ({
      current: await findCurrentRecord(tx, tenantId, employeeId, EMP_TODAY),
      all: await listEmploymentRecords(tx, tenantId, employeeId, EMP_TODAY, { limit: 50, offset: 0 }),
    }));

  return { ...session, db, tenantId, employeeId, cycle: cycle!, attempt, asOwner, insertPartTime, term, primaryView };
}

export type PartTimeWorld = Awaited<ReturnType<typeof partTimeWorld>>;
