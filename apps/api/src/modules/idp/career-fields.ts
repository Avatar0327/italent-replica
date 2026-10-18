/**
 * 职业发展信息的 F-185 字段（DEC-543 / DEC-615）：
 * - 发展条线 / 拟晋升职级 / 拟晋升职务：引用须同租户、存在且启用（复用职务体系的引用校验 requiredJob），候选不按部门 / 条线过滤；
 * - 当前职级 / 职位 / 职务：新建保存时按员工在保存当天（租户时区）有效的任职存快照，不取记录开始日的任职；员工当天没有
 *   有效任职存空；任何编辑都不重取（改日期、改人员也不重取，复刻取舍），所以这里只在新建时调用。
 */
import { type Tx } from '@italent/db';
import { type CAREER_SNAPSHOT_FIELDS, tenantLocalDate } from '@italent/domain';
import { findCurrentRecord } from '../employment/read-model.js';
import { requiredJob } from '../job/validation.js';
import type { WriteContext } from './write-support.js';

const TARGET_KINDS = {
  targetProfessionalLineId: 'professional-lines',
  targetLevelId: 'levels',
  targetPostId: 'posts',
} as const;

/** 本次写入带来的目标字段（非空者）逐个校验引用；null 表示清空，不校验。 */
export async function validateCareerTargets(tx: Tx, ctx: WriteContext, input: Record<string, unknown>) {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  for (const [field, kind] of Object.entries(TARGET_KINDS)) {
    const id = input[field];
    if (typeof id === 'string') await requiredJob(tx, ctx.tenantId, kind, id, asOf);
  }
}

/** 员工保存当天有效任职的职级、职位、职务；没有有效任职时全部为空。 */
export async function careerSnapshot(tx: Tx, ctx: WriteContext, employeeId: string) {
  const record = await findCurrentRecord(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  const fields = (record?.fields ?? {}) as Record<string, string | null | undefined>;
  const value = (field: string) => fields[field] ?? null;
  const snapshot: Record<(typeof CAREER_SNAPSHOT_FIELDS)[number], string | null> = {
    currentLevelId: value('levelId'),
    currentPositionId: value('positionId'),
    currentPostId: value('postId'),
  };
  return snapshot;
}
