/**
 * BE-7 兼职验收测试的共用夹具（docs/08_设计/R2-T05_兼职设计.md §13.2：可信造数放这里，packages/testkit 不放业务造数）。
 * PT-3a 之前没有写入口：在租户事务（app_user + RLS）里直接插底层业务头 + 载荷 + 状态事件 + 记录（§1.3），
 * 不写时间轴；期限链与申请表同样用 SQL。只依赖 main 已有的导出，表或约束缺失时是断言失败而不是导入错误。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db, type Tx } from '@italent/db';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { findCurrentRecord, listEmploymentRecords } from '../../apps/api/src/modules/employment/read-model.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { employmentSession, EMP_TODAY } from './AC-EMP-support.js';
import { uniqueSuffix } from './support/unique.js';

const ENTRY = '2025-01-01';

export interface PartTimeInput {
  readonly serviceType?: string;
  readonly kind?: string;
  readonly startDate?: string;
  readonly endDate?: string | null;
  readonly departmentId?: string;
  readonly place?: string | null;
}

export interface PartTimeSeed extends PartTimeInput {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly departmentId: string;
  /** 给出时同时写第 1 期（source = create）；undefined 不写期限。 */
  readonly endDate?: string | null;
}

/**
 * 可信造数一条兼职记录（底层业务头与记录同 ID，§1.3），不写时间轴；所属周期 = 开始日所在的主职周期。返回记录 ID。
 * 人员状态 / 入职状态不给出，由 0062 触发器取同周期开始日的主职前一条（§1.1“仅为快照”）。
 */
export async function insertPartTimeRecord(tx: Tx, seed: PartTimeSeed): Promise<string> {
  const id = randomUUID();
  const payload = randomUUID();
  const kind = seed.kind ?? 'part_time';
  const start = seed.startDate ?? '2026-09-01';
  const { tenantId, employeeId, departmentId } = seed;
  const [cycle] = rowsOf<{ id: string; entry_date: string }>(
    await tx.execute(sql`SELECT id, entry_date::text FROM employment_cycles
      WHERE tenant_id = ${tenantId} AND employee_id = ${employeeId} AND entry_date <= ${start}::date
      ORDER BY entry_date DESC LIMIT 1`),
  );
  if (!cycle) throw new Error('开始日之前没有任职周期');
  await tx.execute(sql`INSERT INTO employment_business_objects(id, tenant_id, employee_id)
    VALUES (${id}, ${tenantId}, ${employeeId})`);
  await tx.execute(sql`INSERT INTO employment_payload_versions(id, tenant_id, employee_id, business_id, version_no,
      kind, mode, effective_date, form_id, selected_staff_id, department_id, place)
    VALUES (${payload}, ${tenantId}, ${employeeId}, ${id}, 1, ${kind}, 'direct', ${start}, 'part_time',
      ${cycle.id}, ${departmentId}, ${seed.place ?? null})`);
  await tx.execute(sql`INSERT INTO employment_state_events(tenant_id, employee_id, business_id, payload_version_id,
      state, event_no, command_id)
    VALUES (${tenantId}, ${employeeId}, ${id}, ${payload}, 'effective', 1, ${`pt-seed-${id}`})`);
  await tx.execute(sql`INSERT INTO employment_records(id, tenant_id, employee_id, payload_version_id, staff_id,
      entry_date, kind, start_date, service_type, department_id, employ_type, place)
    VALUES (${id}, ${tenantId}, ${employeeId}, ${payload}, ${cycle.id}, ${cycle.entry_date}, ${kind}, ${start},
      ${seed.serviceType ?? 'part_time'}, ${departmentId}, 'internal', ${seed.place ?? null})`);
  if (seed.endDate !== undefined)
    await tx.execute(sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date,
        source, command_id)
      VALUES (${tenantId}, ${employeeId}, ${id}, 1, ${seed.endDate}, 'create', ${`pt-term-${randomUUID()}`})`);
  return id;
}

export interface PartTimeRequestSeed {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly initiatorUserId: string;
  readonly requestType?: 'add' | 'extend' | 'end';
  /** extend / end 的目标兼职记录。 */
  readonly recordId?: string;
  readonly departmentId: string;
  readonly startDate?: string;
  readonly endDate?: string | null;
  readonly serviceType?: string;
  readonly state?: string;
  /** state = effective 的事件必须带落地的兼职记录（CHECK part_time_request_events_record）。 */
  readonly effectiveRecordId?: string;
}

/** 可信造数一张兼职申请（头 + 第 1 版 + 一条状态事件），返回申请 ID。 */
export async function insertPartTimeRequest(tx: Tx, seed: PartTimeRequestSeed): Promise<string> {
  const id = randomUUID();
  const version = randomUUID();
  const { tenantId, employeeId } = seed;
  const type = seed.requestType ?? 'add';
  await tx.execute(sql`INSERT INTO part_time_requests(id, tenant_id, employee_id, request_type, record_id, initiator,
      initiator_user_id)
    VALUES (${id}, ${tenantId}, ${employeeId}, ${type}, ${seed.recordId ?? null}, 'hr', ${seed.initiatorUserId})`);
  await tx.execute(sql`INSERT INTO part_time_request_versions(id, tenant_id, employee_id, request_id, version_no,
      command_id, service_type, department_id, start_date, end_date, base_term_no)
    VALUES (${version}, ${tenantId}, ${employeeId}, ${id}, 1, ${`pt-request-${id}`}, ${seed.serviceType ?? 'part_time'},
      ${seed.departmentId}, ${seed.startDate ?? '2026-09-01'}, ${seed.endDate ?? null}, ${type === 'add' ? null : 1})`);
  const state = seed.state ?? 'in_review';
  await tx.execute(sql`INSERT INTO part_time_request_events(tenant_id, employee_id, request_id, version_id, state,
      event_no, command_id, reason, record_id)
    VALUES (${tenantId}, ${employeeId}, ${id}, ${version}, ${state}, 1, ${`pt-request-${id}`},
      ${state === 'voided' ? 'hr' : null}, ${state === 'effective' ? (seed.effectiveRecordId ?? null) : null})`);
  return id;
}

/** 错误转成“SQLSTATE 约束名 错误文本”，便于同时断言错误码与约束名（触发器抛出的约束名不在文本里）。 */
export function failure(error: unknown) {
  // PGlite 给 constraint，postgres.js 给 constraint_name
  const cause = ((error as { cause?: unknown }).cause ?? error) as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
  };
  return `${cause.code ?? ''} ${cause.constraint ?? cause.constraint_name ?? ''} ${String(cause)}`;
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

  /** 可信造数一条兼职记录（底层业务头与记录同 ID，§1.3），不写时间轴也不写期限；返回记录 ID。 */
  function insertPartTime(tx: Tx, input: PartTimeInput = {}) {
    return insertPartTimeRecord(tx, {
      departmentId: partTimeOrg.id,
      ...input,
      endDate: undefined,
      tenantId,
      employeeId,
    });
  }

  /** 独立事务造一条带第 1 期的兼职记录（结束日缺省为无结束日期）。 */
  const seedPartTime = (input: PartTimeInput = {}) =>
    withTenant(db, tenantId, (tx) =>
      insertPartTimeRecord(tx, { departmentId: partTimeOrg.id, endDate: null, ...input, tenantId, employeeId }),
    );

  /** 独立事务造一张兼职申请（缺省：新增、审批中、兼职部门）。 */
  const seedRequest = (input: Partial<PartTimeRequestSeed> = {}) =>
    withTenant(db, tenantId, (tx) =>
      insertPartTimeRequest(tx, {
        departmentId: partTimeOrg.id,
        initiatorUserId: session.user.id,
        ...input,
        tenantId,
        employeeId,
      }),
    );

  /** 直接调用服务层的任职上下文（可信端口，scope 为空 = 不设范围）。 */
  const context = (expectedRevision = 0, at = `${EMP_TODAY}T01:00:00.000Z`): EmploymentContext => ({
    tenantId,
    userId: session.user.id,
    timezone: session.tenant.timezone,
    now: new Date(at),
    commandId: randomUUID(),
    expectedRevision,
  });

  const term = (recordId: string, termNo: number, endDate: string | null, source: string) =>
    sql`INSERT INTO employment_part_time_terms(tenant_id, employee_id, record_id, term_no, end_date, source, command_id)
      VALUES (${tenantId}, ${employeeId}, ${recordId}, ${termNo}, ${endDate}, ${source}, ${`pt-term-${randomUUID()}`})`;

  /** 主职读口径（时间轴）：当前记录与全部记录。 */
  const primaryView = () =>
    withTenant(db, tenantId, async (tx) => ({
      current: await findCurrentRecord(tx, tenantId, employeeId, EMP_TODAY),
      all: await listEmploymentRecords(tx, tenantId, employeeId, EMP_TODAY, { limit: 50, offset: 0 }),
    }));

  return {
    ...session,
    db,
    tenantId,
    employeeId,
    cycle: cycle!,
    primaryOrg: primary,
    partTimeOrg,
    attempt,
    asOwner,
    insertPartTime,
    seedPartTime,
    seedRequest,
    context,
    term,
    primaryView,
  };
}

export type PartTimeWorld = Awaited<ReturnType<typeof partTimeWorld>>;
