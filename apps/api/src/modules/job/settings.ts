import { and, desc, eq, jobSettingsObjects, jobSettingsVersions, lte, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { businessDate } from './fields.js';
import { auditJob, rowsOf } from './store.js';
import type { JobWriteContext } from './types.js';

export const jobSettingsSchema = z.strictObject({
  allowDuplicatePositionNames: z.boolean(),
  adjustEmployeeDirectManager: z.boolean(),
  startDate: businessDate.optional(),
  stopDate: businessDate.optional(),
  enabled: z.boolean().optional(),
});

/** 所有职务体系写命令共用此锁，跨对象编码、职位重名与配置修改不会并发绕过校验。 */
export async function lockJobTenant(tx: Tx, ctx: JobWriteContext): Promise<number> {
  await tx.insert(jobSettingsObjects).values({ tenantId: ctx.tenantId, createdAt: ctx.now }).onConflictDoNothing();
  const [head] = await tx
    .select()
    .from(jobSettingsObjects)
    .where(eq(jobSettingsObjects.tenantId, ctx.tenantId))
    .for('update');
  if (!head) throw new AppError('SERVICE_UNAVAILABLE', '职务体系配置锁不可用');
  return head.revision;
}

export async function readJobSettings(tx: Tx, tenantId: string, asOf?: string) {
  const [head] = await tx.select().from(jobSettingsObjects).where(eq(jobSettingsObjects.tenantId, tenantId));
  const [version] = await tx
    .select()
    .from(jobSettingsVersions)
    .where(and(eq(jobSettingsVersions.tenantId, tenantId), ...(asOf ? [lte(jobSettingsVersions.startDate, asOf)] : [])))
    .orderBy(desc(jobSettingsVersions.startDate), desc(jobSettingsVersions.versionNo))
    .limit(1);
  const active = version && version.enabled && (!asOf || version.stopDate >= asOf);
  return {
    tenantId,
    revision: head?.revision ?? 0,
    versionId: version?.id,
    startDate: version?.startDate ?? '0001-01-01',
    stopDate: version?.stopDate ?? '9999-12-31',
    enabled: version ? !!active : true,
    allowDuplicatePositionNames: active ? version.allowDuplicatePositionNames : false,
    adjustEmployeeDirectManager: active ? version.adjustEmployeeDirectManager : false,
  };
}

export async function writeJobSettings(tx: Tx, ctx: JobWriteContext, input: z.input<typeof jobSettingsSchema>) {
  const parsed = jobSettingsSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '职位名称与经理联动设置不合法', parsed.error.issues);
  const currentRevision = await lockJobTenant(tx, ctx);
  if (currentRevision !== ctx.expectedRevision) throw new AppError('REVISION_CONFLICT', '职务体系设置已被修改');
  const startDate = parsed.data.startDate ?? tenantLocalDate(ctx.now, ctx.timezone);
  const stopDate = parsed.data.stopDate ?? '9999-12-31';
  if (startDate > stopDate) throw new AppError('VALIDATION_FAILED', '失效日期不得早于生效日期');
  const before = await readJobSettings(tx, ctx.tenantId);
  if (before.versionId && startDate < before.startDate) {
    throw new AppError('JOB_FUTURE_VERSION_EXISTS', '已有后续设置版本，请先处理后续版本');
  }
  if (!parsed.data.allowDuplicatePositionNames || parsed.data.enabled === false) {
    await assertUniquePositionNames(tx, ctx.tenantId, startDate);
  }
  if (stopDate < '9999-12-31') {
    const afterExpiry = new Date(`${stopDate}T00:00:00Z`);
    afterExpiry.setUTCDate(afterExpiry.getUTCDate() + 1);
    await assertUniquePositionNames(tx, ctx.tenantId, afterExpiry.toISOString().slice(0, 10));
  }
  const [version] = await tx
    .insert(jobSettingsVersions)
    .values({
      ...parsed.data,
      tenantId: ctx.tenantId,
      startDate,
      stopDate,
      enabled: parsed.data.enabled ?? true,
      previousVersionId: before.versionId ?? null,
      versionNo: currentRevision + 1,
      createdAt: ctx.now,
    })
    .returning();
  if (!version) throw new AppError('SERVICE_UNAVAILABLE', '职务体系设置保存失败');
  await tx
    .update(jobSettingsObjects)
    .set({ revision: currentRevision + 1 })
    .where(eq(jobSettingsObjects.tenantId, ctx.tenantId));
  const after = await readJobSettings(tx, ctx.tenantId, startDate);
  await auditJob(tx, ctx, 'job.settings.update', 'job_setting', ctx.tenantId, before, after);
  return after;
}

async function assertUniquePositionNames(tx: Tx, tenantId: string, startDate: string): Promise<void> {
  const dates = rowsOf<{ asOf: string }>(
    await tx.execute(sql`
      SELECT DISTINCT start_date::text AS "asOf" FROM job_position_versions
      WHERE tenant_id = ${tenantId} AND start_date >= ${startDate}::date
      UNION SELECT ${startDate}::text LIMIT 201
    `),
  );
  if (dates.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '设置关联的未来职位变更超出单次校验处理上限');
  for (const { asOf } of dates) {
    const duplicates = rowsOf(
      await tx.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (object_id) * FROM job_position_versions
          WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
          ORDER BY object_id, start_date DESC, version_no DESC
        )
        SELECT org_id, name FROM latest WHERE enabled AND stop_date >= ${asOf}::date
        GROUP BY org_id, name HAVING count(*) > 1 LIMIT 1
      `),
    );
    if (duplicates.length) throw new AppError('CONFLICT', '现有启用职位重名，不能关闭允许重名设置');
  }
}
