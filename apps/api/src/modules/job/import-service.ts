import { pgErrorCode, sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { jobCreationSchema } from './fields.js';
import { JOB_KINDS, jobTables, type JobKind } from './metadata.js';
import { latestJobObject } from './read-model.js';
import { lockJobTenant } from './settings.js';
import { auditJob, insertRow, rowsOf, snakeCase } from './store.js';
import type { JobInput, JobWriteContext } from './types.js';
import { createJobObject, updateJobObject } from './write-service.js';
import { recordImportLog } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';

export interface JobImportRow extends JobInput {
  readonly sourceCode: string;
  readonly code: string;
  readonly objectId?: string;
  readonly expectedRevision?: number;
}

interface Receipt {
  readonly sourceCode: string;
  readonly code: string;
  readonly status: 'created' | 'updated' | 'conflict';
  readonly objectId?: string;
  readonly reason?: string;
}

interface Snapshot {
  readonly mappings: Map<string, string>;
  readonly codeOwners: Map<string, Set<string>>;
}

export async function importJobObjects(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  inputRows: readonly JobImportRow[],
  authorizeRow?: (row: JobImportRow, targetId: string | undefined, rowIndex: number) => Promise<void>,
) {
  assertRows(inputRows);
  const parsed = z
    .array(
      jobCreationSchema(kind).extend({
        sourceCode: z.string().trim().min(1).max(100),
        objectId: z.uuid().optional(),
        expectedRevision: z.number().int().min(1).optional(),
      }),
    )
    .safeParse(inputRows);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '导入行字段不合法', parsed.error.issues);
  const rows = parsed.data as JobImportRow[];
  await lockJobTenant(tx, ctx);
  const snapshot = await importSnapshot(tx, ctx, kind, rows);
  assertUpdateRevisions(rows, snapshot);
  const sources = new Set<string>();
  const codes = new Set<string>();
  const results: Receipt[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const target = snapshot.mappings.get(row.sourceCode) ?? row.objectId;
    await authorizeRow?.(row, target, rowIndex);
    const reason = conflictReason(kind, row, target, snapshot, sources, codes);
    sources.add(row.sourceCode);
    codes.add(row.code);
    const result = reason
      ? { sourceCode: row.sourceCode, code: row.code, status: 'conflict' as const, reason }
      : await importRow(tx, ctx, kind, row, target, snapshot.mappings.has(row.sourceCode));
    await insertRow(tx, 'job_import_results', {
      tenantId: ctx.tenantId,
      commandId: ctx.commandId,
      rowIndex,
      kind,
      sourceCode: result.sourceCode,
      code: result.code,
      status: result.status,
      reason: result.reason ?? null,
      ...(result.objectId ? { [jobTables(kind).importTarget]: result.objectId } : {}),
    });
    // DEC-197 / PR #75 第三轮：逐行回执按所属组织（职位）裁剪，其余职务体系对象按回执里的对象编号判断创建人
    const orgId = kind === 'positions' ? ((row.orgId as string | undefined) ?? null) : null;
    await auditJob(tx, ctx, 'job.import.result', kind, `${ctx.commandId}:${rowIndex}`, null, result, { orgId });
    results.push(result);
    if (result.objectId) {
      snapshot.mappings.set(result.sourceCode, result.objectId);
      const owners = snapshot.codeOwners.get(result.code) ?? new Set<string>();
      owners.add(`${kind}:${result.objectId}`);
      snapshot.codeOwners.set(result.code, owners);
    }
  }
  const anchors = rows.map((row, rowIndex) => ({
    objectId: results[rowIndex]?.objectId ?? row.objectId ?? null,
    orgId: kind === 'positions' ? ((row.orgId as string | undefined) ?? null) : null,
  }));
  await recordImportLog(tx, { ...ctx, actorUserId: auditActor(ctx.userId) }, kind, results, anchors);
  return { results };
}

async function importSnapshot(tx: Tx, ctx: JobWriteContext, kind: JobKind, rows: readonly JobImportRow[]) {
  const sources = sql.join(
    rows.map((row) => sql`${row.sourceCode}`),
    sql`, `,
  );
  const desiredCodes = sql.join(
    rows.map((row) => sql`${row.code}`),
    sql`, `,
  );
  const mapped = rowsOf<{ sourceCode: string; objectId: string }>(
    await tx.execute(sql`
      SELECT source_code AS "sourceCode", ${sql.identifier(snakeCase(jobTables(kind).importTarget))} AS "objectId"
      FROM job_import_mappings WHERE tenant_id = ${ctx.tenantId} AND kind = ${kind} AND source_code IN (${sources})
      LIMIT 100
    `),
  );
  const floor = [
    tenantLocalDate(ctx.now, ctx.timezone),
    ...rows.map((row) => row.startDate ?? '9999-12-31'),
  ].sort()[0]!;
  const codeOwners = new Map<string, Set<string>>();
  for (const otherKind of JOB_KINDS) {
    const occupied = rowsOf<{ code: string; objectId: string }>(
      await tx.execute(sql`
        WITH daily AS (
          SELECT DISTINCT ON (object_id, start_date) * FROM ${sql.identifier(jobTables(otherKind).versionTable)}
          WHERE tenant_id = ${ctx.tenantId} ORDER BY object_id, start_date, version_no DESC
        ), periods AS (
          SELECT *, lead(start_date) OVER (PARTITION BY object_id ORDER BY start_date) AS next_start FROM daily
        ) SELECT DISTINCT code, object_id AS "objectId" FROM periods WHERE code IN (${desiredCodes})
          AND LEAST(stop_date, COALESCE(next_start - 1, stop_date)) >= ${floor}::date LIMIT 201
      `),
    );
    if (occupied.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '导入编码校验超出处理上限');
    for (const owner of occupied) {
      const owners = codeOwners.get(owner.code) ?? new Set<string>();
      owners.add(`${otherKind}:${owner.objectId}`);
      codeOwners.set(owner.code, owners);
    }
  }
  return { mappings: new Map(mapped.map((row) => [row.sourceCode, row.objectId])), codeOwners };
}

function assertRows(rows: readonly JobImportRow[]): void {
  if (!Array.isArray(rows) || rows.length < 1) throw new AppError('VALIDATION_FAILED', '导入至少需要一行');
  if (rows.length > 100) throw new AppError('PAYLOAD_TOO_LARGE', '单次职务体系导入最多 100 行');
  for (const row of rows) {
    if (!row || typeof row.sourceCode !== 'string' || !row.sourceCode.trim() || !row.code || !row.name) {
      throw new AppError('VALIDATION_FAILED', '导入每行必须填写原站编码、业务编码和名称');
    }
  }
}

function assertUpdateRevisions(rows: readonly JobImportRow[], snapshot: Snapshot): void {
  for (const row of rows) {
    if (!row.objectId && !snapshot.mappings.has(row.sourceCode)) continue;
    if (row.expectedRevision === undefined) throw new AppError('REVISION_REQUIRED', '更新映射对象必须提供 revision');
    if (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 1) {
      throw new AppError('VALIDATION_FAILED', '导入更新 revision 必须是正整数');
    }
  }
}

function conflictReason(
  kind: JobKind,
  row: JobImportRow,
  target: string | undefined,
  snapshot: Snapshot,
  sources: Set<string>,
  codes: Set<string>,
) {
  if (sources.has(row.sourceCode)) return 'DUPLICATE_SOURCE_CODE';
  if (codes.has(row.code)) return 'DUPLICATE_CODE';
  const mapped = snapshot.mappings.get(row.sourceCode);
  if (mapped && row.objectId && mapped !== row.objectId) return 'SOURCE_MAPPING_CONFLICT';
  const owners = snapshot.codeOwners.get(row.code);
  if (owners && [...owners].some((owner) => owner !== `${kind}:${target}`)) return 'CODE_CONFLICT';
  return undefined;
}

async function importRow(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  row: JobImportRow,
  target: string | undefined,
  mapped: boolean,
): Promise<Receipt> {
  try {
    return await tx.transaction(async (savepoint) => {
      const { sourceCode, objectId: _objectId, expectedRevision, ...input } = row;
      const object = target
        ? await updateMapped(savepoint, ctx, kind, target, input, expectedRevision!)
        : await createJobObject(savepoint, { ...ctx, expectedRevision: 0 }, kind, input);
      if (!mapped) {
        const mapping = { tenantId: ctx.tenantId, kind, sourceCode, [jobTables(kind).importTarget]: object.id };
        await insertRow(savepoint, 'job_import_mappings', mapping);
        await auditJob(savepoint, ctx, 'job.import.map', kind, object.id, null, mapping);
      }
      return { sourceCode, code: object.code, status: target ? 'updated' : 'created', objectId: object.id };
    });
  } catch (error) {
    if (error instanceof AppError || pgErrorCode(error) === '23505') {
      const reason = error instanceof AppError ? error.code : 'CODE_CONFLICT';
      return { sourceCode: row.sourceCode, code: row.code, status: 'conflict', reason };
    }
    throw error;
  }
}

async function updateMapped(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  id: string,
  input: JobInput,
  expectedRevision: number,
) {
  if (!(await latestJobObject(tx, ctx.tenantId, kind, id))) throw new AppError('NOT_FOUND', '映射对象不存在');
  const { startDate, ...patch } = input;
  return updateJobObject(tx, { ...ctx, expectedRevision }, kind, id, {
    ...patch,
    effectiveDate: startDate ?? tenantLocalDate(ctx.now, ctx.timezone),
  });
}

export async function authorizeJobImportRows(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  rows: readonly JobImportRow[],
  authorize: (row: JobImportRow, targetId: string | undefined) => Promise<void>,
) {
  const sources = sql.join(
    rows.map((row) => sql`${row.sourceCode}`),
    sql`, `,
  );
  const mappings = rowsOf<{ sourceCode: string; objectId: string }>(
    await tx.execute(sql`
    SELECT source_code AS "sourceCode", ${sql.identifier(snakeCase(jobTables(kind).importTarget))} AS "objectId"
    FROM job_import_mappings WHERE tenant_id=${ctx.tenantId} AND kind=${kind} AND source_code IN (${sources}) LIMIT 100
  `),
  );
  const targets = new Map(mappings.map((row) => [row.sourceCode, row.objectId]));
  for (const row of rows) await authorize(row, targets.get(row.sourceCode) ?? row.objectId);
}
