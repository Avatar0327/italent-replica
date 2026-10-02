import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { JOB_KINDS, jobTables, type JobKind } from './metadata.js';
import { listJobObjects } from './read-model.js';
import { readJobSettings } from './settings.js';
import { rowsOf } from './store.js';
import type { JobFields, JobWriteContext } from './types.js';

/** DEC-060：同日取最新版本，再按真实有效窗口检测八类对象的跨表编码冲突。 */
export async function assertJobCodeAvailable(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  fields: JobFields,
  exceptId?: string,
): Promise<void> {
  for (const otherKind of JOB_KINDS) {
    const table = sql.identifier(jobTables(otherKind).versionTable);
    const matches = rowsOf(
      await tx.execute(sql`
        WITH daily AS (
          SELECT DISTINCT ON (object_id, start_date) * FROM ${table}
          WHERE tenant_id = ${ctx.tenantId}
          ORDER BY object_id, start_date, version_no DESC
        ), periods AS (
          SELECT *, lead(start_date) OVER (PARTITION BY object_id ORDER BY start_date) AS next_start FROM daily
        )
        SELECT object_id FROM periods
        WHERE code = ${fields.code}
          AND object_id <> ${kind === otherKind && exceptId ? exceptId : '00000000-0000-0000-0000-000000000000'}::uuid
          AND start_date <= ${fields.stopDate}::date
          AND LEAST(stop_date, COALESCE(next_start - 1, stop_date)) >= ${fields.startDate}::date
        LIMIT 1
      `),
    );
    if (matches.length) throw new AppError('CONFLICT', '职务体系编码已使用', { reason: 'CODE_CONFLICT' });
  }
}

export async function positionBoundaries(tx: Tx, tenantId: string, startDate: string, stopDate: string) {
  const result = await tx.execute(sql`
    SELECT DISTINCT value::text AS "asOf" FROM (
      SELECT start_date AS value FROM job_position_versions WHERE tenant_id = ${tenantId}
      UNION SELECT start_date FROM job_settings_versions WHERE tenant_id = ${tenantId}
      UNION SELECT stop_date + 1 FROM job_settings_versions
        WHERE tenant_id = ${tenantId} AND stop_date < '9999-12-31'
      UNION SELECT ${startDate}::date
    ) boundaries WHERE value >= ${startDate}::date AND value <= ${stopDate}::date ORDER BY "asOf" LIMIT 201
  `);
  const rows = rowsOf<{ asOf: string }>(result);
  if (rows.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '职位未来变更超出单次校验处理上限');
  return rows.map((row) => row.asOf);
}

export async function assertPositionNameAvailable(
  tx: Tx,
  ctx: JobWriteContext,
  fields: JobFields,
  exceptId?: string,
): Promise<void> {
  if (!fields.enabled) return;
  for (const asOf of await positionBoundaries(tx, ctx.tenantId, fields.startDate, fields.stopDate)) {
    if ((await readJobSettings(tx, ctx.tenantId, asOf)).allowDuplicatePositionNames) continue;
    const matches = await listJobObjects(tx, ctx.tenantId, 'positions', {
      asOf,
      name: fields.name,
      orgId: fields.orgId as string,
      enabled: true,
      limit: 2,
      offset: 0,
    });
    if (matches.some((record) => record.id !== exceptId)) {
      throw new AppError('CONFLICT', '同一部门启用职位名称不得重复', { reason: 'POSITION_NAME_DUPLICATE' });
    }
  }
}
