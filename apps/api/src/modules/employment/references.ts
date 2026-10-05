import { sql, type Tx } from '@italent/db';
import { assertOrg } from '../establishment/org-reader.js';
import type { JobRecord } from '../job/read-model.js';
import { invalid, requiredJob, validateJobAssignment } from '../job/validation.js';
import { rowsOf } from './read-model.js';
import { assertNoReportingCycle, insertedWindow, type ReportingWindow } from './reporting-cycle.js';
import type { EmploymentContext, PresetFields } from './types.js';

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
): Promise<void> {
  const tenantId = ctx.tenantId;
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
          AND t.valid_during @> ${effectiveDate}::date AND r.kind NOT IN ('leave', 'retirement') LIMIT 1
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
