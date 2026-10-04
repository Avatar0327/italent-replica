import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { SUBSETS } from '@italent/domain';
import type { EmploymentContext, EmploymentRecord } from '../employment/types.js';
import { loadEmploymentRecord } from '../employment/read-model.js';
import { rows, camel, type Row } from './store.js';
import { persistSubset } from './subsets.js';

const switches: Record<string, string> = {
  hire: 'EntrySyncJobHistory',
  rehire: 'EntrySyncJobHistory',
  retire_rehire: 'EntrySyncJobHistory',
  transfer: 'TransferSyncJobHistory',
  leave: 'DismissSyncJobHistory',
  retirement: 'DismissSyncJobHistory',
};
async function enabled(tx: Tx, tenantId: string, key: string) {
  const [setting] = rows(
    await tx.execute(sql`SELECT CASE WHEN o.active THEN o.value ELSE s.value END AS value
    FROM system_settings s LEFT JOIN tenant_setting_overrides o ON o.key=s.key AND o.tenant_id=${tenantId}
    WHERE s.key=${key} LIMIT 1`),
  );
  // An unprovisioned switch cannot authorize linked writes. Do not infer original-site defaults.
  return setting?.value === true;
}
/** Same-transaction materialization/edit/delete hook; employee lock is held by the employment command. */
export async function syncEmploymentHistory(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  recordId: string,
  kind: string,
  effectiveDate: string,
) {
  const trigger = await loadEmploymentRecord(tx, ctx.tenantId, recordId, effectiveDate);
  const mayCreate = Boolean(switches[kind]) && (await enabled(tx, ctx.tenantId, switches[kind]!));
  const terminal = ['leave', 'retirement'].includes(kind);
  // 触发记录自己的履历单独按 recordId 取；同日可有多条任职（DEC-108），按日期截取会漏掉它而重复插入。
  const existing = [
    ...rows(
      await tx.execute(sql`SELECT j.* FROM personnel_job_history j
      WHERE j.tenant_id=${ctx.tenantId} AND j.employee_id=${employeeId}::uuid AND NOT j.deleted
        AND j.employment_record_id=${recordId}::uuid LIMIT 1`),
    ),
    ...(trigger ? await previousHistory(tx, ctx, employeeId, recordId) : []),
  ].map(camel);
  // TODO(需取证 Q-M0-37)：离职是否另建历史行未取证；只同步已知工作区间终点，不虚构离职后任期。
  if (mayCreate && trigger && !terminal && !existing.some((row) => row.employmentRecordId === recordId))
    existing.push({ employmentRecordId: recordId });
  for (const previous of existing) {
    const record = await loadEmploymentRecord(tx, ctx.tenantId, String(previous.employmentRecordId), effectiveDate);
    const leaveDate =
      terminal && trigger?.staffId === record?.staffId
        ? await lastWorkDate(tx, ctx.tenantId, recordId)
        : (previous.leaveDate ?? null);
    await syncOne(tx, ctx, employeeId, previous, record, leaveDate);
  }
}
/** 时间轴上（生效日 + 同日操作先后）排在触发记录之前、同周期内最近一条已有履历的任职，其结束日随之变化。 */
async function previousHistory(tx: Tx, ctx: EmploymentContext, employeeId: string, recordId: string) {
  return rows(
    await tx.execute(sql`SELECT j.* FROM employment_timeline t
      JOIN employment_timeline p ON p.tenant_id=t.tenant_id AND p.employee_id=t.employee_id AND p.staff_id=t.staff_id
        AND (p.start_date,p.sort_order)<(t.start_date,t.sort_order)
      JOIN personnel_job_history j ON j.tenant_id=p.tenant_id AND j.employee_id=p.employee_id
        AND j.employment_record_id=p.record_id AND NOT j.deleted
      WHERE t.tenant_id=${ctx.tenantId} AND t.employee_id=${employeeId}::uuid AND t.record_id=${recordId}::uuid
      ORDER BY p.start_date DESC,p.sort_order DESC LIMIT 1`),
  );
}
async function syncOne(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  previous: Row,
  record: EmploymentRecord | null,
  leaveDate: unknown,
) {
  const before = previous.id ? previous : null;
  if (!record) {
    if (before)
      await persistSubset(tx, ctx, 'jobhistory', before, {
        ...before,
        deleted: true,
        revision: Number(before.revision) + 1,
        commandId: ctx.commandId,
      });
    return;
  }
  const fields = { ...record.fields };
  const snapshot: Row = {
    isThisCompany: true,
    employmentRecordId: record.id,
    startDate: record.effectiveDate,
    endDate: record.stopDate === '9999-12-31' ? null : record.stopDate,
    entryDate: record.entryDate,
    leaveDate,
    employmentType: fields.employmentType,
    ...(await referenceNames(tx, ctx, fields, record.effectiveDate)),
  };
  if (before && Object.entries(snapshot).every(([key, value]) => (before[key] ?? null) === value)) return;
  const row: Row = {
    ...Object.fromEntries(SUBSETS.jobhistory.fields.map((f) => [f.code, null])),
    ...before,
    ...snapshot,
    id: before?.id ?? randomUUID(),
    tenantId: ctx.tenantId,
    employeeId,
    revision: Number(before?.revision ?? 0) + 1,
    deleted: false,
    sourceType: 'employment_sync',
    sourceId: record.id,
    createdBy: before?.createdBy ?? ctx.userId,
    createdAt: before?.createdAt ?? ctx.now.toISOString(),
    commandId: ctx.commandId,
  };
  await persistSubset(tx, ctx, 'jobhistory', before, row);
}
async function referenceNames(tx: Tx, ctx: EmploymentContext, fields: Row, date: string) {
  const [tenant] = rows(
    await tx.execute(sql`SELECT name FROM org_versions WHERE tenant_id=${ctx.tenantId}
    AND org_id=${ctx.tenantId} AND start_date<=${date}::date ORDER BY start_date DESC,version_no DESC LIMIT 1`),
  );
  const result: Row = { company: tenant?.name ?? null, departmentFullName: null };
  for (const [target, table, field] of [
    ['department', 'org_versions', 'departmentId'],
    ['post', 'job_post_versions', 'postId'],
    ['position', 'job_position_versions', 'positionId'],
    ['level', 'job_level_versions', 'levelId'],
  ]) {
    if (!fields[field!]) {
      result[target!] = null;
      continue;
    }
    const id = sql.identifier(table === 'org_versions' ? 'org_id' : 'object_id');
    const extra = table === 'org_versions' ? sql`,full_name` : sql``;
    const [version] = rows(
      await tx.execute(sql`SELECT name${extra} FROM ${sql.identifier(table!)}
      WHERE tenant_id=${ctx.tenantId} AND ${id}=${fields[field!]}::uuid AND start_date<=${date}::date
      ORDER BY start_date DESC,version_no DESC LIMIT 1`),
    );
    result[target!] = version?.name ?? null;
    if (table === 'org_versions') result.departmentFullName = version?.full_name ?? null;
  }
  return result;
}
async function lastWorkDate(tx: Tx, tenantId: string, recordId: string) {
  const [record] = rows(
    await tx.execute(sql`SELECT last_work_date::text FROM employment_records
    WHERE tenant_id=${tenantId} AND id=${recordId}::uuid LIMIT 1`),
  );
  return record ? camel(record).lastWorkDate : null;
}
