import { randomUUID } from 'node:crypto';
import { isUuid, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { jobCreationSchema, jobPatchSchema, normalizeFields } from './fields.js';
import { jobTables, type JobKind } from './metadata.js';
import { applyPositionPersonnelRules, unavailableJobPersonnel } from './personnel.js';
import { latestJobObject, loadJobObject, type JobRecord } from './read-model.js';
import { lockJobTenant } from './settings.js';
import { auditJob, insertRow, rowsOf } from './store.js';
import type { JobFields, JobInput, JobPatch, JobPersonnelGateway, JobWriteContext } from './types.js';
import { assertJobCodeAvailable, assertPositionNameAvailable, positionBoundaries } from './uniqueness.js';
import { invalid, treeFields, validateJobFields } from './validation.js';

export type { JobIncumbent, JobInput, JobPatch, JobPersonnelGateway, JobWriteContext } from './types.js';

export async function createJobObject(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  input: JobInput,
  _personnel: JobPersonnelGateway = unavailableJobPersonnel,
): Promise<JobRecord> {
  assertRevision(ctx.expectedRevision, 0);
  const id = randomUUID();
  const normalized = normalizeFields(ctx, kind, input);
  await lockJobTenant(tx, ctx);
  const fields = await validateJobFields(tx, ctx, kind, id, normalized);
  await assertJobCodeAvailable(tx, ctx, kind, fields);
  if (kind === 'positions') await assertPositionNameAvailable(tx, ctx, fields);
  await insertRow(tx, jobTables(kind).objectTable, {
    id,
    tenantId: ctx.tenantId,
    revision: 1,
    createdAt: ctx.now.toISOString(),
  });
  const saved = await appendVersion(tx, ctx, kind, id, 1, fields, null);
  await assertFutureHierarchy(tx, ctx, kind, id, fields);
  await auditJob(tx, ctx, 'job.create', kind, id, null, saved);
  return saved;
}

export async function updateJobObject(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  id: string,
  patch: JobPatch,
  personnel: JobPersonnelGateway = unavailableJobPersonnel,
): Promise<JobRecord> {
  if (!isUuid(id)) throw invalid('id', '对象 ID 必须是 UUID');
  const parsed = jobPatchSchema(kind).safeParse(patch);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '职务体系变更字段不合法', parsed.error.issues);
  await lockJobTenant(tx, ctx);
  const current = await lockObject(tx, ctx, kind, id);
  assertRevision(ctx.expectedRevision, current.revision);
  const { adjustEmployeeDirectManager = false, ...changes } = parsed.data as JobPatch;
  const effectiveDate = changes.effectiveDate;
  assertTemporalOrder(current, effectiveDate);
  const input = mergeInput(kind, current, changes, effectiveDate);
  const fields = await validateJobFields(tx, ctx, kind, id, normalizeFields(ctx, kind, input));
  await assertJobCodeAvailable(tx, ctx, kind, fields, id);
  if (kind === 'positions') {
    await assertPositionNameAvailable(tx, ctx, fields, id);
    await applyPositionPersonnelRules(tx, ctx, current, fields, { adjustEmployeeDirectManager }, personnel);
  }
  await updateRevision(tx, ctx, kind, id, current.revision + 1);
  const saved = await appendVersion(tx, ctx, kind, id, current.revision + 1, fields, current.versionId);
  await assertFutureHierarchy(tx, ctx, kind, id, fields);
  await auditJob(tx, ctx, 'job.update', kind, id, current, saved);
  if ((kind === 'sequences' || kind === 'professional-lines') && fields.parentId !== current.parentId) {
    await synchronizeDescendantTrees(tx, ctx, kind, id, effectiveDate);
  }
  return saved;
}

export function assertTemporalOrder(current: { startDate: string }, effectiveDate: string): void {
  // DEC-072：不在已排定的后续版本之前插入历史变更，避免隐式覆盖未来业务值。
  if (effectiveDate < current.startDate) {
    throw new AppError('JOB_FUTURE_VERSION_EXISTS', '对象已有后续版本，请先处理后续版本');
  }
}

function assertRevision(expected: number, actual: number): void {
  if (expected !== actual)
    throw new AppError('REVISION_CONFLICT', '对象已被修改，请刷新后显式重提', { expected, actual });
}

export function jobRecordInput(kind: JobKind, record: JobRecord): JobInput {
  const allowed = Object.keys(jobCreationSchema(kind).shape);
  return Object.fromEntries(allowed.map((key) => [key, record[key]])) as JobInput;
}

function mergeInput(
  kind: JobKind,
  current: JobRecord,
  patch: Record<string, unknown>,
  effectiveDate: string,
): JobInput {
  const { effectiveDate: _effectiveDate, ...changes } = patch;
  const before = jobRecordInput(kind, current);
  const input = { ...before, ...changes, startDate: effectiveDate };
  if (kind === 'positions') {
    input.parents = { ...before.parents, ...(changes.parents as JobInput['parents']) };
  }
  return input;
}

async function lockObject(tx: Tx, ctx: JobWriteContext, kind: JobKind, id: string): Promise<JobRecord> {
  const head = rowsOf(
    await tx.execute(sql`
      SELECT id FROM ${sql.identifier(jobTables(kind).objectTable)}
      WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid FOR UPDATE
    `),
  );
  if (!head.length) throw new AppError('NOT_FOUND', '职务体系对象不存在');
  const record = await latestJobObject(tx, ctx.tenantId, kind, id);
  if (!record) throw new AppError('SERVICE_UNAVAILABLE', '职务体系对象版本不可用');
  return record;
}

async function updateRevision(tx: Tx, ctx: JobWriteContext, kind: JobKind, id: string, revision: number) {
  await tx.execute(sql`
    UPDATE ${sql.identifier(jobTables(kind).objectTable)} SET revision = ${revision}
    WHERE tenant_id = ${ctx.tenantId} AND id = ${id}::uuid
  `);
}

async function appendVersion(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  id: string,
  revision: number,
  fields: JobFields,
  previousVersionId: string | null,
): Promise<JobRecord> {
  const tables = jobTables(kind);
  const business = Object.fromEntries(tables.fields.map((key) => [key, fields[key]]));
  await insertRow(tx, tables.versionTable, {
    ...business,
    id: randomUUID(),
    tenantId: ctx.tenantId,
    objectId: id,
    versionNo: revision,
    previousVersionId,
    createdAt: ctx.now.toISOString(),
  });
  const saved = await latestJobObject(tx, ctx.tenantId, kind, id);
  if (!saved) throw new AppError('SERVICE_UNAVAILABLE', '职务体系版本保存失败');
  return saved;
}

async function synchronizeDescendantTrees(
  tx: Tx,
  ctx: JobWriteContext,
  kind: 'sequences' | 'professional-lines',
  id: string,
  effectiveDate: string,
): Promise<void> {
  const table = sql.identifier(jobTables(kind).versionTable);
  const children = rowsOf<{ id: string }>(
    await tx.execute(sql`
      WITH RECURSIVE latest AS (
        SELECT DISTINCT ON (object_id) * FROM ${table}
        WHERE tenant_id = ${ctx.tenantId} AND start_date <= ${effectiveDate}::date
        ORDER BY object_id, start_date DESC, version_no DESC
      ), children AS (
        SELECT object_id FROM latest WHERE parent_id = ${id}::uuid AND stop_date >= ${effectiveDate}::date
        UNION SELECT v.object_id FROM latest v JOIN children c ON v.parent_id = c.object_id
        WHERE v.stop_date >= ${effectiveDate}::date
      ) SELECT object_id AS id FROM children LIMIT 201
    `),
  );
  if (children.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '单次最多调整 200 个下级主数据对象');
  for (const child of children) {
    const current = await lockObject(tx, ctx, kind, child.id);
    assertTemporalOrder(current, effectiveDate);
    const normalized = normalizeFields(ctx, kind, { ...jobRecordInput(kind, current), startDate: effectiveDate });
    const fields = { ...normalized, ...(await treeFields(tx, ctx, kind, child.id, normalized)) };
    await updateRevision(tx, ctx, kind, child.id, current.revision + 1);
    const saved = await appendVersion(tx, ctx, kind, child.id, current.revision + 1, fields, current.versionId);
    await auditJob(tx, ctx, 'job.tree.synchronize', kind, child.id, current, saved);
  }
}

async function assertFutureHierarchy(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  id: string,
  fields: JobFields,
): Promise<void> {
  if (kind !== 'positions' && kind !== 'sequences' && kind !== 'professional-lines') return;
  const table = sql.identifier(jobTables(kind).versionTable);
  const dates =
    kind === 'positions'
      ? await positionBoundaries(tx, ctx.tenantId, fields.startDate, fields.stopDate)
      : rowsOf<{ asOf: string }>(
          await tx.execute(sql`
        SELECT DISTINCT start_date::text AS "asOf" FROM ${table}
        WHERE tenant_id = ${ctx.tenantId} AND start_date >= ${fields.startDate}::date
          AND start_date <= ${fields.stopDate}::date LIMIT 201
      `),
        ).map((row) => row.asOf);
  if (dates.length > 200) throw new AppError('PAYLOAD_TOO_LARGE', '层级的未来变更超出单次校验处理上限');
  for (const asOf of dates) {
    for (const dimension of kind === 'positions' ? ['directParentId', 'dottedParentId'] : ['parentId']) {
      const seen = new Set([id]);
      let parentId = fields[dimension];
      while (typeof parentId === 'string') {
        if (seen.size >= 200) throw new AppError('PAYLOAD_TOO_LARGE', '层级超出单次校验处理上限');
        if (seen.has(parentId)) throw invalid(dimension, '未来时点的层级不得形成环');
        seen.add(parentId);
        const parent = await loadJobObject(tx, ctx.tenantId, kind, parentId, asOf, true);
        parentId = parent?.[dimension];
      }
    }
  }
}
