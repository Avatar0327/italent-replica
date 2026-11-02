import { validateEmploymentForm } from './employment-forms.js';
import { validateEmploymentType } from './employment-types.js';
import { sql, type Tx } from '@italent/db';
import { assertOrg } from '../establishment/org-reader.js';
import { latestJobObject, type JobRecord } from '../job/read-model.js';
import { invalid, requiredJob, validateJobAssignment } from '../job/validation.js';
import { rowsOf } from './read-model.js';
import { assertNoReportingCycle, insertedWindow, type ReportingWindow } from './reporting-cycle.js';
import type { EmploymentContext, PresetFields } from './types.js';
import { AppError } from '../../errors.js';
import { lockOrganizationSettings } from '../org/locks.js';
import { employmentDepartmentDisable, type EmploymentDepartmentDisable } from '../org/employment-validity.js';

/**
 * DEC-150：只扩展新增任职业务及申请修改；历史记录编辑、向后引用判定保留各自已有日期口径。
 * reporting 原样交给 validateEmploymentReferences 校验循环汇报。
 */
export async function validateNewEmploymentReferences(
  tx: Tx,
  ctx: EmploymentContext,
  fields: PresetFields,
  effectiveDate: string,
  reporting?: ReportingCheck,
  entry = false,
  /** 离职 / 退休落地（R2-T03 §5.1 步骤 2，R-O6）：记录不占用部门、不在某一天“在职”，只校验稳定对象存在且同租户。 */
  terminating = false,
): Promise<void> {
  if (terminating) return validateTerminatingReferences(tx, ctx, fields);
  await assertEmploymentDepartmentAvailable(tx, ctx, fields.departmentId, effectiveDate, entry);
  await validateEmploymentReferences(tx, ctx, fields, effectiveDate, reporting);
}

const JOB_REFERENCES = [
  ['positionId', 'positions'],
  ['postId', 'posts'],
  ['levelId', 'levels'],
  ['gradeId', 'grades'],
  ['sequenceId', 'sequences'],
  ['professionalLineId', 'professional-lines'],
] as const;

/**
 * 离职 / 退休记录的引用校验（离职设计 §5.1 步骤 2）：字段已按实际插入点从前驱继承，这里只证明引用的稳定对象仍存在于本租户
 * （组织、职务体系对象、经理的员工身份），不判可用性、不按某一天解析——调动当天新设的部门、同日离职的经理都是合法引用；
 * 部门可用性对离职不适用（B-69），在职段延长由 §6B 在步骤 0c 校验，循环汇报只在显式设置经理时校验（离职不设置）。
 */
async function validateTerminatingReferences(tx: Tx, ctx: EmploymentContext, fields: PresetFields): Promise<void> {
  const tenantId = ctx.tenantId;
  await validateEmploymentForm(tx, tenantId, fields.employmentForm);
  await validateEmploymentType(tx, tenantId, fields.employmentType);
  if (fields.departmentId) {
    const [org] = rowsOf(
      await tx.execute(sql`SELECT 1 FROM org_objects WHERE tenant_id=${tenantId} AND id=${fields.departmentId}::uuid`),
    );
    if (!org) throw invalid('departmentId', '任职部门不存在或不在当前租户');
  }
  for (const [field, kind] of JOB_REFERENCES) {
    const id = fields[field];
    if (id && !(await latestJobObject(tx, tenantId, kind, id))) throw invalid(field, '引用对象不存在或不在当前租户');
  }
  for (const id of [fields.directManagerId, fields.dottedManagerId]) {
    if (!id) continue;
    const [employee] = rowsOf(
      await tx.execute(sql`SELECT 1 FROM employment_employees WHERE tenant_id=${tenantId} AND id=${id}::uuid`),
    );
    if (!employee) throw invalid('managerId', '经理不存在或不在当前租户');
  }
}

/**
 * DEC-196：与停用共用组织锁，整段可用性在锁内复查；完整锁序见 org/locks.ts。
 * entry = 入职类业务（添加待入职 / 编辑 / 办理入职 / 入职接口的唯一入口，DEC-138 / 139，34 EN-R16）：
 * 另拦入职日早于部门设立日，停用按入职日落在停用期内 / 在停用日之前给两种提示（W-433 / 436 / 437，提示语照搬原站）。
 */
export async function assertEmploymentDepartmentAvailable(
  tx: Tx,
  ctx: EmploymentContext,
  departmentId: string | null,
  effectiveDate: string,
  entry = false,
): Promise<void> {
  if (departmentId) {
    await lockOrganizationSettings(tx, ctx.tenantId);
    if (entry) await assertNotBeforeFounded(tx, ctx.tenantId, departmentId, effectiveDate);
    // 等待锁期间可能已提交停用版本；必须在获得锁之后重新读取。
    const disabled = await employmentDepartmentDisable(tx, ctx.tenantId, departmentId, effectiveDate);
    if (disabled) throw departmentDisabled(disabled, entry ? effectiveDate : undefined);
    await assertOrg(tx, ctx.tenantId, departmentId, effectiveDate);
  }
}

/**
 * 有终点变体（离职设计 §6B.2-3）：任职部门在 [from, to) 内任一天不可用即拒绝，to 为空表示开放（只要之后停用就拒绝）。
 * 用于撤销 / 顺延等“扩大在职区间”的操作按 ΔO 逐段校验；同样取停用锁并在锁内复查，拒绝形态与无终点变体一致。
 * `employmentDepartmentDisable` 返回从 from 起（或覆盖 from）的第一个不可用段，其起日早于 to 即与区间相交。
 */
export async function assertEmploymentDepartmentAvailableWithin(
  tx: Tx,
  ctx: EmploymentContext,
  departmentId: string | null,
  from: string,
  to: string | null,
): Promise<void> {
  if (!departmentId) return;
  await lockOrganizationSettings(tx, ctx.tenantId);
  const disabled = await employmentDepartmentDisable(tx, ctx.tenantId, departmentId, from);
  if (disabled && (to === null || disabled.disabledOn < to)) throw departmentDisabled(disabled);
}

/**
 * 停用拒绝的统一构造。entryDate 只在入职类业务（entry）传入：停用日不晚于入职日（入职时已处于停用期内）给“在入职日期时为停用状态”
 * 提示，否则给“已被停用（停用日期）”提示（W-433 / 436 / 437，提示语照搬原站）。
 */
function departmentDisabled(disabled: EmploymentDepartmentDisable, entryDate?: string): AppError {
  const atEntry = entryDate !== undefined && disabled.disabledOn <= entryDate;
  return new AppError(
    'VALIDATION_FAILED',
    atEntry
      ? `任职部门【${disabled.name}】在入职日期（${entryDate}）时为停用状态，请检查`
      : `任职部门【${disabled.name}】已被停用（停用日期：${disabled.disabledOn}），请检查`,
    { reason: 'EMPLOYMENT_DEPARTMENT_DISABLED', disabledOn: disabled.disabledOn },
  );
}

async function assertNotBeforeFounded(tx: Tx, tenantId: string, departmentId: string, entryDate: string) {
  const [first] = rowsOf<{ name: string; founded: string }>(
    await tx.execute(sql`SELECT name, start_date::text AS founded FROM org_versions
      WHERE tenant_id=${tenantId} AND org_id=${departmentId}::uuid ORDER BY start_date, version_no LIMIT 1`),
  );
  if (first && entryDate < first.founded)
    throw new AppError(
      'VALIDATION_FAILED',
      `入职日期（${entryDate}）不能早于任职部门【${first.name}】的最早生效日期（${first.founded}），` +
        '请检查修改入职日期或通过修改部门的设立日期来调整部门最早生效日期',
      { reason: 'ENTRY_BEFORE_DEPARTMENT_FOUNDED', founded: first.founded },
    );
}

/** 循环汇报校验的对象：哪名员工，被校验的记录在时间轴上实际生效的区间（为空则不校验）。 */
export interface ReportingCheck {
  readonly employeeId: string;
  readonly window: ReportingWindow | null;
}

/**
 * docs/02_业务建模/15 §8：以任职生效日解析引用，不取对象的当前版本。
 * reporting：本次写入明确设置了直线经理时传入，另校验不得形成循环汇报（`19` §3.1 Q-M0-58）；
 * 沿用的经理不再校验，免得存量环路挡住与经理无关的业务。
 */
export async function validateEmploymentReferences(
  tx: Tx,
  ctx: EmploymentContext,
  fields: PresetFields,
  effectiveDate: string,
  reporting?: ReportingCheck,
  managerAsOf = effectiveDate,
): Promise<void> {
  const tenantId = ctx.tenantId;
  await validateEmploymentForm(tx, tenantId, fields.employmentForm);
  await validateEmploymentType(tx, tenantId, fields.employmentType);
  if (fields.departmentId) await assertOrg(tx, tenantId, fields.departmentId, effectiveDate);
  const position = fields.positionId
    ? await requiredJob(tx, tenantId, 'positions', fields.positionId, effectiveDate)
    : undefined;
  if (position) {
    if (position.orgId !== fields.departmentId) throw invalid('positionId', '职位必须属于任职部门');
    if (fields.postId && position.postId && position.postId !== fields.postId)
      throw invalid('postId', '职位与所选职务不一致');
  }
  const postId = fields.postId ?? (typeof position?.postId === 'string' ? position.postId : null);
  if (postId) {
    await validateJobAssignment(tx, tenantId, {
      postId,
      levelId: fields.levelId ?? undefined,
      gradeId: fields.gradeId ?? undefined,
      asOf: effectiveDate,
    });
  }
  await validatePositionRanges(tx, tenantId, position, fields, effectiveDate);
  for (const [id, kind] of [
    [fields.sequenceId, 'sequences'],
    [fields.professionalLineId, 'professional-lines'],
  ] as const) {
    if (id) await requiredJob(tx, tenantId, kind, id, effectiveDate);
  }
  for (const id of [fields.directManagerId, fields.dottedManagerId]) {
    if (!id) continue;
    const [employee] = rowsOf(
      await tx.execute(sql`
        SELECT 1 FROM employment_timeline t
        JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
        WHERE t.tenant_id=${tenantId} AND t.employee_id=${id}::uuid
          AND t.valid_during @> ${managerAsOf}::date AND r.kind NOT IN ('leave', 'retirement') LIMIT 1
      `),
    );
    if (!employee) throw invalid('managerId', '经理在任职生效日必须处于在职状态');
  }
  if (reporting)
    await assertNoReportingCycle(tx, tenantId, reporting.employeeId, fields.directManagerId, reporting.window);
}

/** 本次写入是否明确设置了直线经理（新增 / 申请看表单显式字段，编辑看补丁）。 */
export function setsDirectManager(explicitFieldCodes: readonly string[]): boolean {
  return explicitFieldCodes.includes('preset:directManagerId');
}

/** 新记录明确设置了直线经理时，按它插入时间轴后的有效区间校验（DEC-108；recordId 见 insertedWindow）。 */
export async function newRecordReporting(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  explicitFieldCodes: readonly string[],
  date: string,
  recordId?: string,
): Promise<ReportingCheck | undefined> {
  if (!setsDirectManager(explicitFieldCodes)) return undefined;
  return { employeeId, window: await insertedWindow(tx, ctx, employeeId, date, recordId) };
}

async function validatePositionRanges(
  tx: Tx,
  tenantId: string,
  position: JobRecord | undefined,
  fields: PresetFields,
  asOf: string,
): Promise<void> {
  const level = fields.levelId ? await requiredJob(tx, tenantId, 'levels', fields.levelId, asOf) : undefined;
  const grade = fields.gradeId ? await requiredJob(tx, tenantId, 'grades', fields.gradeId, asOf) : undefined;
  for (const owner of [position, level]) {
    if (typeof owner?.levelTypeId === 'string') await requiredJob(tx, tenantId, 'level-types', owner.levelTypeId, asOf);
  }
  if (position && level) {
    if (position.levelTypeId && position.levelTypeId !== level.levelTypeId)
      throw invalid('levelId', '职级类别与职位不一致');
    await validateRange(tx, tenantId, position, level, 'level', asOf);
  }
  if (grade) {
    if (position) await validateRange(tx, tenantId, position, grade, 'grade', asOf);
    if (level) await validateRange(tx, tenantId, level, grade, 'grade', asOf);
  }
}

/** 区间按级别数值比较，不能比较 UUID、名称或列表顺序。每个边界只读一版。 */
async function validateRange(
  tx: Tx,
  tenantId: string,
  owner: JobRecord,
  selected: JobRecord,
  value: 'level' | 'grade',
  asOf: string,
): Promise<void> {
  if (typeof selected[value] !== 'number') throw invalid(`${value}Id`, '所选对象缺少级别数值');
  const suffix = value === 'level' ? 'LevelId' : 'GradeId';
  for (const [boundId, lower] of [
    [owner[`min${suffix}`], true],
    [owner[`max${suffix}`], false],
  ] as const) {
    if (typeof boundId !== 'string') continue;
    const bound = await requiredJob(tx, tenantId, value === 'level' ? 'levels' : 'grades', boundId, asOf);
    if (typeof bound[value] !== 'number') throw invalid(`${value}Id`, '区间边界缺少级别数值');
    if (lower ? Number(selected[value]) < Number(bound[value]) : Number(selected[value]) > Number(bound[value]))
      throw invalid(`${value}Id`, '所选值不在允许区间交集内');
  }
}
