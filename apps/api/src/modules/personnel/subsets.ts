import { randomUUID } from 'node:crypto';
import { sql, type Tx } from '@italent/db';
import { SUBSETS, type SubsetKind } from '@italent/domain';
import { AppError } from '../../errors.js';
import { appendEmployee, employeeSnapshot } from './employee-write.js';
import {
  audit,
  assertRevision,
  camel,
  insert,
  lockPerson,
  rows,
  update,
  type PersonnelContext,
  type Row,
} from './store.js';
import { validateDates } from './validation.js';
import { validateAttachments } from './attachments.js';
import { runSubsetSavePolicy, type SubsetSource } from './subset-policy.js';

export async function loadSubset(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  kind: SubsetKind,
  id: string,
  includeDeleted = false,
) {
  const [raw] = rows(
    await tx.execute(sql`SELECT * FROM ${sql.identifier(SUBSETS[kind].table)}
    WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND id=${id}::uuid
    ${includeDeleted ? sql`` : sql`AND NOT deleted`} LIMIT 1`),
  );
  if (!raw) throw new AppError('NOT_FOUND', '子集记录不存在');
  return camel(raw);
}
export async function saveSubset(
  tx: Tx,
  ctx: PersonnelContext,
  employeeId: string,
  kind: SubsetKind,
  patch: Row,
  id?: string,
  deleted = false,
  source: SubsetSource = { type: 'hr_direct', id: null },
) {
  await lockPerson(tx, ctx, employeeId);
  await validateAttachments(tx, ctx, employeeId, patch);
  const before = id ? await loadSubset(tx, ctx, employeeId, kind, id) : null;
  assertRevision(ctx.expectedRevision, Number(before?.revision ?? 0));
  if (before?.isThisCompany) {
    if (deleted) throw new AppError('CONFLICT', '本单位经历由任职记录维护');
    const locked = new Set([
      'company',
      'department',
      'departmentFullName',
      'post',
      'position',
      'level',
      'startDate',
      'endDate',
      'entryDate',
      'leaveDate',
      'employmentType',
      'employmentRecordId',
      'isThisCompany',
    ]);
    if (Object.keys(patch).some((field) => locked.has(field)))
      throw new AppError('VALIDATION_FAILED', '任职同步字段不可编辑');
  }
  const fields = Object.fromEntries(SUBSETS[kind].fields.map((f) => [f.code, null]));
  const row: Row = {
    ...fields,
    ...before,
    ...patch,
    id: id ?? randomUUID(),
    tenantId: ctx.tenantId,
    employeeId,
    revision: Number(before?.revision ?? 0) + 1,
    deleted,
    sourceType: source.type,
    sourceId: source.id,
    createdBy: before?.createdBy ?? ctx.userId,
    createdAt: before?.createdAt ?? ctx.now.toISOString(),
    commandId: ctx.commandId,
  };
  validateDates(row);
  // P0 契约：按子集登记的落地前复核（HR / 自助落地 / 信息采集同一处），锁人后、写入前
  await runSubsetSavePolicy(tx, ctx, kind, { before, row, deleted, source });
  await clearFlags(tx, ctx, kind, row);
  await persistSubset(tx, ctx, kind, before, row);
  await reflectFlags(tx, ctx, employeeId, kind);
  return row;
}
export async function persistSubset(tx: Tx, ctx: PersonnelContext, kind: SubsetKind, before: Row | null, row: Row) {
  const table = SUBSETS[kind].table;
  if (before) await update(tx, table, row, sql`tenant_id=${ctx.tenantId} AND id=${row.id}::uuid`);
  else await insert(tx, table, row);
  await insert(tx, `${table}_versions`, {
    ...row,
    id: randomUUID(),
    recordId: row.id,
    createdAt: ctx.now.toISOString(),
    commandId: ctx.commandId,
  });
  await audit(
    tx,
    ctx,
    SUBSETS[kind].objectCode,
    String(row.employeeId),
    String(row.id),
    Number(row.revision),
    before,
    row,
  );
}
const FLAG_MAP: Partial<Record<SubsetKind, Record<string, Record<string, string>>>> = {
  education: {
    isHighestEducation: { educationLevel: 'educationLevel', lastSchool: 'school', graduateDate: 'endDate' },
    isFirstEducation: { firstEducationLevel: 'educationLevel' },
    isHighestDegree: { highestDegree: 'degree' },
    isMainMajor: { major: 'major' },
  },
  'professional-technical-post': { isHighestLevel: { highestTechnicalLevel: 'level' } },
  'vocational-qualification': { isHighestLevel: { highestVocationalLevel: 'level' } },
};
async function clearFlags(tx: Tx, ctx: PersonnelContext, kind: SubsetKind, row: Row) {
  if (row.deleted) return;
  for (const flag of Object.keys(FLAG_MAP[kind] ?? {})) {
    if (row[flag] !== true) continue;
    const column = flag.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const old = rows(
      await tx.execute(sql`SELECT * FROM ${sql.identifier(SUBSETS[kind].table)}
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${row.employeeId}::uuid AND id<>${row.id}::uuid
        AND NOT deleted AND ${sql.identifier(column)}=true LIMIT 1`),
    );
    for (const raw of old) {
      const before = camel(raw);
      await persistSubset(tx, ctx, kind, before, {
        ...before,
        [flag]: false,
        revision: Number(before.revision) + 1,
        commandId: ctx.commandId,
      });
    }
  }
}
async function reflectFlags(tx: Tx, ctx: PersonnelContext, employeeId: string, kind: SubsetKind) {
  const map = FLAG_MAP[kind];
  if (!map) return;
  const patch: Row = {};
  for (const [flag, fields] of Object.entries(map)) {
    const column = flag.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const [raw] = rows(
      await tx.execute(sql`SELECT * FROM ${sql.identifier(SUBSETS[kind].table)}
      WHERE tenant_id=${ctx.tenantId} AND employee_id=${employeeId}::uuid AND NOT deleted
      AND ${sql.identifier(column)}=true LIMIT 1`),
    );
    const record = raw ? camel(raw) : {};
    for (const [target, source] of Object.entries(fields)) patch[target] = record[source] ?? null;
  }
  const previous = await employeeSnapshot(tx, ctx, employeeId);
  if (Object.entries(patch).some(([key, value]) => (previous?.[key] ?? null) !== value))
    await appendEmployee(tx, ctx, employeeId, patch, false);
}
