/**
 * F-493 历史离职人员导入：一行的写入（设计 §4.2 步骤 3～9）。
 * 一行 = 人员 + 档案 + 教育经历 + 入职 + 离职（直接落为 effective）+ 停用账号 + 绑定 + 停用任务，全部在调用方给的
 * 同一事务里：任何一步抛错都整行回滚（调用方负责开事务与回滚后的失败登记）。
 * 离职段不走生效链：不触发 onEffective、不写 exit_effects / employment_activation_attempts（设计 §5）。
 */
import { exitAccountTasks, exitRequests, permissionUserPersonLinks, sql, type Tx } from '@italent/db';
import {
  checkProfileOption,
  PROFILE_GENDER_OPTIONS,
  PROFILE_NATION_OPTIONS,
  PROFILE_POLITICAL_STATUS_OPTIONS,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import { auditActor } from '../../system-actor.js';
import { audit as auditPermission, type WriteContext } from '../permission/audit.js';
import { lockPersonLink } from '../permission/user-provisioning.js';
import { insertMembership, memberSnapshot } from '../permission/tenant-users.js';
import { appendEmployee } from '../personnel/employee-write.js';
import type { Row } from '../personnel/store.js';
import { saveSubset } from '../personnel/subsets.js';
import { employeeInput } from '../personnel/validation.js';
import { auditEmployment } from './context.js';
import { createEmployee } from './employees.js';
import { auditTask } from './exit-account-store.js';
import { dutyTransferTiming, selectedStaffOf } from './exit-application.js';
import { emailKey, isoOf, type ImportRowInput, type RowError } from './exit-import-shape.js';
import type { ResolvedImportRow } from './exit-import-resolve.js';
import { lockEmploymentBusiness, lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { EmploymentContext } from './types.js';
import { appendEmploymentState, createEmploymentBusiness, materializeEmploymentRecord } from './write-service.js';

/** 档案字段 → 模板列字母（档案端口报格式错时，按字段回指到列）。 */
const PROFILE_COLUMN: Readonly<Record<string, string>> = {
  email: 'C',
  workDate: 'I',
  idNumber: 'K',
  mobilePhone: 'L',
  backupMail: 'M',
  gender: 'N',
  birthday: 'O',
  nation: 'P',
  politicalStatus: 'Q',
  householdAddress: 'R',
  registAddress: 'S',
};
/** 任职 / 职务体系字段 → 列字母（job 校验以 invalid(field, …) 抛出，field 是资源名或字段名）。 */
const REFERENCE_COLUMN: Readonly<Record<string, string>> = {
  departmentId: 'D',
  positionId: 'F',
  positions: 'F',
  postId: 'G',
  posts: 'G',
  levelId: 'H',
  levels: 'H',
  place: 'J',
};

/**
 * 教育经历写入计划（T / U 列）：提交守卫与写入端口共用这一份，授权按实际写入字段的并集判（含两个标志，
 * 与实习生建档同口径，设计 §6.1）。学校与专业都空则不建教育经历。
 */
export function educationPatch(row: ImportRowInput): Row | null {
  if (!row.school && !row.major) return null;
  return {
    ...(row.school ? { school: row.school } : {}),
    ...(row.major ? { major: row.major } : {}),
    isHighestEducation: true,
    isMainMajor: true,
  };
}

/** 档案补丁：邮箱必写；其余只写有值的列。国籍不写默认值（设计 §3.3：北森模板没有这一列）。 */
export function profilePatch(row: ImportRowInput): Row {
  const option = (options: readonly string[], value: string | null) => checkProfileOption(options, value).ok && value;
  const patch: Row = row.email ? { email: emailKey(row.email) } : {};
  const put = (key: string, value: string | false | null) => {
    if (value) patch[key] = value;
  };
  if (row.idNumber) {
    patch.idType = 'id_card';
    patch.idNumber = row.idNumber;
  }
  put('backupMail', row.personalEmail && emailKey(row.personalEmail));
  put('mobilePhone', row.mobilePhone);
  put('workDate', isoOf(row.workDate));
  put('birthday', isoOf(row.birthday));
  put('householdAddress', row.householdAddress);
  put('registAddress', row.registAddress);
  put('gender', option(PROFILE_GENDER_OPTIONS, row.gender));
  put('nation', option(PROFILE_NATION_OPTIONS, row.nation));
  put('politicalStatus', option(PROFILE_POLITICAL_STATUS_OPTIONS, row.politicalStatus));
  return patch;
}

/** 逐字段过档案端口的输入校验：哪一列不合格就报哪一列 INVALID_FORMAT（写入前、不碰数据库）。 */
export function profileFormatErrors(patch: Row): RowError[] {
  const errors: RowError[] = [];
  for (const [key, value] of Object.entries(patch)) {
    try {
      employeeInput({ [key]: value });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      errors.push({ column: PROFILE_COLUMN[key] ?? null, reason: 'INVALID_FORMAT' });
    }
  }
  // idType 与 idNumber 同属 K 列，只报一次
  return errors.filter((e, i) => errors.findIndex((o) => o.column === e.column) === i);
}

/** 业务拒绝（4xx AppError）转成行级错误：能按字段回指到列的报该列，其余按行级系统错误处理。 */
export function rowErrorOf(error: AppError): RowError {
  const field = (error.details as { field?: unknown } | undefined)?.field;
  const column = typeof field === 'string' ? REFERENCE_COLUMN[field] : undefined;
  if (column) return { column, reason: error.message.includes('停用') ? 'REFERENCE_DISABLED' : 'REFERENCE_NOT_FOUND' };
  return { column: null, reason: 'SYSTEM_ERROR' };
}

export interface ImportBatchRef {
  readonly id: string;
  readonly submittedBy: string;
}
export interface ImportedRow {
  readonly employeeId: string;
  readonly exitBusinessId: string;
  /** false = 联系邮箱已是别的账号的登录名，账号照建但没有登录名（b 类，设计 §4.5）。 */
  readonly loginAssigned: boolean;
}

export async function writeImportRow(
  tx: Tx,
  ctx: EmploymentContext,
  batch: ImportBatchRef,
  row: ImportRowInput,
  resolved: ResolvedImportRow,
): Promise<ImportedRow> {
  const importCtx: EmploymentContext = { ...ctx, trustedExit: 'import', expectedRevision: 0 };
  const employee = await createEmployee(tx, importCtx, { code: null, name: row.name! });
  const personnel = { ...importCtx };
  await appendEmployee(tx, personnel, employee.id, profilePatch(row), false);
  const education = educationPatch(row);
  if (education) await saveSubset(tx, personnel, employee.id, 'education', education);

  const afterCreate = await lockEmploymentEmployee(tx, importCtx, employee.id);
  const fields = {
    departmentId: resolved.departmentId,
    ...(resolved.positionId ? { positionId: resolved.positionId } : {}),
    ...(resolved.postId ? { postId: resolved.postId } : {}),
    ...(resolved.levelId ? { levelId: resolved.levelId } : {}),
    ...(row.place ? { place: row.place } : {}),
  };
  await createEmploymentBusiness(
    tx,
    { ...importCtx, expectedRevision: afterCreate.revision },
    employee.id,
    { kind: 'hire', mode: 'direct', effectiveDate: resolved.entryDate, fields, customFields: {} },
    { importedTenure: { until: resolved.effectiveDate } },
  );
  const afterHire = await lockEmploymentEmployee(tx, importCtx, employee.id);
  const leave = await createEmploymentBusiness(
    tx,
    { ...importCtx, expectedRevision: afterHire.revision },
    employee.id,
    { kind: 'leave', mode: 'direct', lastWorkDate: resolved.lastWorkDate, fields: {}, customFields: {} },
  );
  await tx.insert(exitRequests).values({
    tenantId: ctx.tenantId,
    businessId: leave.id,
    employeeId: employee.id,
    staffId: await selectedStaffOf(tx, ctx, leave.id),
    mode: 'import',
    initiator: 'hr',
    initiatorUserId: batch.submittedBy,
    exitTypeCode: resolved.exitTypeCode,
    reasonCode: resolved.reasonCode,
    whereaboutsCode: resolved.whereaboutsCode,
    batchId: batch.id,
    dutyTransferTiming: await dutyTransferTiming(tx, ctx.tenantId),
    preReleaseDate: resolved.effectiveDate,
  });
  await settleEffective(tx, importCtx, leave.id);
  const loginAssigned = await provisionDisabledAccount(tx, ctx, batch, row, employee.id, leave.id);
  await assertOnlyImportedBusinesses(tx, ctx, employee.id);
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.imported',
    'exit-request',
    leave.id,
    null,
    {
      state: 'effective',
      mode: 'import',
      lastWorkDate: resolved.lastWorkDate,
      effectiveDate: resolved.effectiveDate,
      batchId: batch.id,
      rowNo: row.rowNo,
    },
    undefined,
    undefined,
    { employeeId: employee.id },
  );
  return { employeeId: employee.id, exitBusinessId: leave.id, loginAssigned };
}

/** 直接落为 effective 并物化时间线；不走 activateExit，所以不触发 onEffective / 账号 / 合同 / 交接。 */
async function settleEffective(tx: Tx, importCtx: EmploymentContext, businessId: string) {
  // 业务刚由本事务创建，revision 读出即可，没有他人并发的空间（员工行锁已持有）
  const [head] = rowsOf<{ revision: number }>(
    await tx.execute(sql`SELECT revision FROM employment_business_objects
      WHERE tenant_id=${importCtx.tenantId} AND id=${businessId}::uuid`),
  );
  const settleCtx = { ...importCtx, expectedRevision: Number(head!.revision) };
  const locked = await lockEmploymentBusiness(tx, settleCtx, businessId);
  await appendEmploymentState(tx, settleCtx, locked, 'effective');
  await materializeEmploymentRecord(tx, settleCtx, locked, { forwardUpdate: false, skipStatusPropagation: true });
}

/**
 * 停用账号 + 成员 + 绑定 + 停用任务（设计 §4.5）：历史离职人员不发凭据、不给权限；账号由 SECURITY DEFINER 函数创建，
 * 联系邮箱已是别人的登录名时账号不带登录名（loginAssigned = false），不改动对方账号。
 */
async function provisionDisabledAccount(
  tx: Tx,
  ctx: EmploymentContext,
  batch: ImportBatchRef,
  row: ImportRowInput,
  employeeId: string,
  exitBusinessId: string,
): Promise<boolean> {
  const commandId = `exit-import:${batch.id}:${row.rowNo}`;
  const [account] = rowsOf<{ account_id: string; login_assigned: boolean }>(
    await tx.execute(sql`SELECT * FROM tenant_provision_import_account(${emailKey(row.email!)}::text,
      ${row.name!}::text, ${batch.submittedBy}::uuid, ${commandId}::text)`),
  );
  const userId = account!.account_id;
  const write: WriteContext = { tenantId: ctx.tenantId, userId: batch.submittedBy, now: ctx.now, commandId };
  await lockPersonLink(tx, ctx.tenantId, userId);
  const membership = await insertMembership(tx, write, userId, {
    userType: 'internal',
    businessIdentity: null,
    updatedAt: ctx.now,
  });
  await tx.insert(permissionUserPersonLinks).values({ tenantId: ctx.tenantId, userId, employeeId });
  await auditPermission(tx, write, {
    action: 'tenant_user.provision',
    objectType: 'tenant_user',
    objectId: userId,
    before: null,
    after: { ...memberSnapshot(membership), accountCreated: true, source: 'exit_import' },
  });
  // 账号新建时 revision = 1；任务记下它，日后重聘恢复账号时据此判断账号自导入后有没有被人改过
  const [task] = await tx
    .insert(exitAccountTasks)
    .values({
      tenantId: ctx.tenantId,
      businessId: exitBusinessId,
      employeeId,
      userId,
      handlerUserId: auditActor(batch.submittedBy),
      status: 'disabled',
      commandId,
      autoRevision: 1,
    })
    .returning();
  await auditTask(tx, ctx, null, task!); // 任务与审计同事务（设计 §10.3）
  return account!.login_assigned;
}

/** 防御：新建的人员名下只应有入职与离职两条业务；多出来说明有别的流程介入，宁可整行回滚。 */
async function assertOnlyImportedBusinesses(tx: Tx, ctx: EmploymentContext, employeeId: string) {
  const [count] = rowsOf<{ n: string }>(
    await tx.execute(sql`SELECT count(*) AS n FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid`),
  );
  if (Number(count?.n) !== 2)
    throw new AppError('SERVICE_UNAVAILABLE', '导入结果自检未通过', { reason: 'INTERNAL_INVARIANT' });
}
