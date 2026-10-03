import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { AppError } from '../../errors.js';
import { creatorSql } from '../permission/scope-audit.js';
import { scopeSql } from '../permission/module-access.js';
import { jobTables, type JobKind } from './metadata.js';

export interface PositionParent {
  readonly parentId: string | null;
  readonly sequence: number | null;
}

export interface JobRecord {
  readonly [field: string]: unknown;
  readonly id: string;
  readonly tenantId: string;
  readonly kind: JobKind;
  readonly versionId: string;
  readonly versionNo: number;
  readonly revision: number;
  readonly previousVersionId: string | null;
  readonly code: string;
  readonly name: string;
  readonly startDate: string;
  readonly stopDate: string;
  readonly enabled: boolean;
  readonly establishedOn: string | null;
  readonly displayOrder: number | null;
  readonly qualificationId: string | null;
  readonly layerLevel?: number | null;
  readonly grade?: number | null;
  readonly scoreLow?: number | null;
  readonly scoreHigh?: number | null;
  readonly layerId?: string | null;
  readonly level?: number | null;
  readonly levelTypeId?: string | null;
  readonly minLevelId?: string | null;
  readonly maxLevelId?: string | null;
  readonly minGradeId?: string | null;
  readonly maxGradeId?: string | null;
  readonly parentId?: string | null;
  readonly sequenceId?: string | null;
  readonly professionalLineId?: string | null;
  readonly orgId?: string;
  readonly postId?: string;
  readonly directParentId?: string | null;
  readonly dottedParentId?: string | null;
  readonly directSequence?: number | null;
  readonly dottedSequence?: number | null;
  readonly standardPositionId?: string | null;
  readonly competencyModelId?: string | null;
  readonly evaluationScore?: number | null;
  readonly syncSequenceToAssignments?: boolean;
  readonly parents?: { readonly admin: PositionParent; readonly dotted: PositionParent };
}

export function resultRows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

function record(kind: JobKind, row: Record<string, unknown>): JobRecord {
  const converted = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
  for (const field of ['scoreLow', 'scoreHigh', 'evaluationScore']) {
    if (converted[field] !== null && converted[field] !== undefined) converted[field] = Number(converted[field]);
  }
  const item = { ...converted, id: converted.objectId, versionId: converted.id, kind } as JobRecord;
  if (kind !== 'positions') return item;
  return {
    ...item,
    parents: {
      admin: { parentId: item.directParentId ?? null, sequence: item.directSequence ?? null },
      dotted: { parentId: item.dottedParentId ?? null, sequence: item.dottedSequence ?? null },
    },
  };
}

async function queryRecords(tx: Tx, kind: JobKind, query: SQL): Promise<JobRecord[]> {
  return resultRows<Record<string, unknown>>(await tx.execute(query)).map((row) => record(kind, row));
}

/** 先选该时点最新版本，再判断是否失效，不能回退到更早的启用版本。 */
function effectiveVersions(kind: JobKind, tenantId: string, asOf: string): SQL {
  return sql`SELECT DISTINCT ON (object_id) * FROM ${sql.identifier(jobTables(kind).versionTable)}
    WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
    ORDER BY object_id, start_date DESC, version_no DESC`;
}

export async function loadJobObject(
  tx: Tx,
  tenantId: string,
  kind: JobKind,
  id: string,
  asOf: string,
  includeInactive = false,
): Promise<JobRecord | undefined> {
  const table = jobTables(kind);
  const rows = await queryRecords(
    tx,
    kind,
    sql`
    SELECT v.*, o.revision FROM (
      SELECT * FROM ${sql.identifier(table.versionTable)}
      WHERE tenant_id = ${tenantId} AND object_id = ${id}::uuid AND start_date <= ${asOf}::date
      ORDER BY start_date DESC, version_no DESC LIMIT 1
    ) v JOIN ${sql.identifier(table.objectTable)} o ON o.tenant_id = v.tenant_id AND o.id = v.object_id
    WHERE v.stop_date >= ${asOf}::date AND (${includeInactive} OR v.enabled) LIMIT 1
  `,
  );
  return rows[0];
}

export async function latestJobObject(
  tx: Tx,
  tenantId: string,
  kind: JobKind,
  id: string,
): Promise<JobRecord | undefined> {
  const table = jobTables(kind);
  const rows = await queryRecords(
    tx,
    kind,
    sql`
    SELECT v.*, o.revision FROM ${sql.identifier(table.versionTable)} v
    JOIN ${sql.identifier(table.objectTable)} o ON o.tenant_id = v.tenant_id AND o.id = v.object_id
    WHERE v.tenant_id = ${tenantId} AND v.object_id = ${id}::uuid
    ORDER BY v.start_date DESC, v.version_no DESC LIMIT 1
  `,
  );
  return rows[0];
}

export interface JobListQuery {
  readonly scope?: Parameters<typeof scopeSql>[0];
  readonly asOf: string;
  readonly name?: string;
  readonly orgId?: string;
  readonly enabled?: boolean;
  readonly limit: number;
  readonly offset: number;
}

export async function listJobObjects(tx: Tx, tenantId: string, kind: JobKind, query: JobListQuery) {
  checkPage(query.limit, query.offset);
  const predicates = [sql`v.stop_date >= ${query.asOf}::date`];
  if (query.scope)
    predicates.push(
      scopeSql(query.scope, {
        ...(kind === 'positions' ? { org: sql`v.org_id` } : {}),
        creator: creatorSql(tenantId, sql`v.object_id`, 'job.create', kind),
      }),
    );
  if (query.enabled !== undefined) predicates.push(sql`v.enabled = ${query.enabled}`);
  if (query.name !== undefined) predicates.push(sql`v.name = ${query.name}`);
  if (query.orgId !== undefined) {
    if (kind !== 'positions') throw new AppError('VALIDATION_FAILED', '所属组织只适用于职位');
    predicates.push(sql`v.org_id = ${query.orgId}::uuid`);
  }
  return queryRecords(
    tx,
    kind,
    sql`
    SELECT v.*, o.revision FROM (${effectiveVersions(kind, tenantId, query.asOf)}) v
    JOIN ${sql.identifier(jobTables(kind).objectTable)} o ON o.tenant_id = v.tenant_id AND o.id = v.object_id
    WHERE ${sql.join(predicates, sql` AND `)}
    ORDER BY v.display_order ASC NULLS LAST, v.code, v.object_id LIMIT ${query.limit} OFFSET ${query.offset}
  `,
  );
}

function checkPage(limit: number, offset: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError('VALIDATION_FAILED', '分页参数超出允许范围');
  }
}

export interface CandidateQuery {
  readonly scope?: Parameters<typeof scopeSql>[0];
  readonly postId: string;
  readonly levelId?: string;
  readonly asOf: string;
  readonly limit?: number;
  readonly offset?: number;
}

export async function jobCandidates(
  tx: Tx,
  tenantId: string,
  query: CandidateQuery,
  kind: 'levels' | 'grades' = 'levels',
): Promise<JobRecord[]> {
  const post = await requiredObject(tx, tenantId, 'posts', query.postId, query.asOf);
  const predicates = [sql`v.enabled`, sql`v.stop_date >= ${query.asOf}::date`];
  if (query.scope)
    predicates.push(scopeSql(query.scope, { creator: creatorSql(tenantId, sql`v.object_id`, 'job.create', kind) }));
  if (post.levelTypeId) {
    await requiredObject(tx, tenantId, 'level-types', post.levelTypeId, query.asOf);
    if (kind === 'levels') predicates.push(sql`v.level_type_id = ${post.levelTypeId}::uuid`);
  }
  const range =
    kind === 'levels'
      ? await numericRange(tx, tenantId, kind, post.minLevelId, post.maxLevelId, query.asOf)
      : await numericRange(tx, tenantId, kind, post.minGradeId, post.maxGradeId, query.asOf);
  if (kind === 'grades' && query.levelId) {
    const level = await requiredObject(tx, tenantId, 'levels', query.levelId, query.asOf);
    await assertLevelInPost(tx, tenantId, post, level, query.asOf);
    const levelRange = await numericRange(tx, tenantId, 'grades', level.minGradeId, level.maxGradeId, query.asOf);
    range.low = Math.max(range.low, levelRange.low);
    range.high = Math.min(range.high, levelRange.high);
  }
  const value = kind === 'levels' ? sql`v.level` : sql`v.grade`;
  predicates.push(sql`${value} IS NOT NULL`);
  if (kind === 'levels') {
    predicates.push(sql`(v.level_type_id IS NULL OR EXISTS (
      SELECT 1 FROM (
        SELECT enabled,stop_date FROM job_level_type_versions t
        WHERE t.tenant_id=${tenantId} AND t.object_id=v.level_type_id AND t.start_date<=${query.asOf}::date
        ORDER BY t.start_date DESC,t.version_no DESC LIMIT 1
      ) t WHERE t.enabled AND t.stop_date>=${query.asOf}::date
    ))`);
  }
  if (Number.isFinite(range.low)) predicates.push(sql`${value} >= ${range.low}`);
  if (Number.isFinite(range.high)) predicates.push(sql`${value} <= ${range.high}`);
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  checkPage(limit, offset);
  return queryRecords(
    tx,
    kind,
    sql`
    SELECT v.*, o.revision FROM (${effectiveVersions(kind, tenantId, query.asOf)}) v
    JOIN ${sql.identifier(jobTables(kind).objectTable)} o ON o.tenant_id = v.tenant_id AND o.id = v.object_id
    WHERE ${sql.join(predicates, sql` AND `)}
    ORDER BY ${value}, v.code, v.object_id LIMIT ${limit} OFFSET ${offset}
  `,
  );
}

async function requiredObject(tx: Tx, tenantId: string, kind: JobKind, id: string, asOf: string) {
  const item = await loadJobObject(tx, tenantId, kind, id, asOf);
  if (!item) throw new AppError('VALIDATION_FAILED', '引用的职务对象在该时点不可用', { kind });
  return item;
}

async function numericRange(
  tx: Tx,
  tenantId: string,
  kind: 'levels' | 'grades',
  minId: string | null | undefined,
  maxId: string | null | undefined,
  asOf: string,
) {
  const field = kind === 'levels' ? 'level' : 'grade';
  const minimum = minId ? (await requiredObject(tx, tenantId, kind, minId, asOf))[field] : -Infinity;
  const maximum = maxId ? (await requiredObject(tx, tenantId, kind, maxId, asOf))[field] : Infinity;
  if (typeof minimum !== 'number' || typeof maximum !== 'number') {
    throw new AppError('VALIDATION_FAILED', '职级或职等区间必须有数值级别');
  }
  return { low: minimum, high: maximum };
}

async function assertLevelInPost(tx: Tx, tenantId: string, post: JobRecord, level: JobRecord, asOf: string) {
  if (level.levelTypeId) await requiredObject(tx, tenantId, 'level-types', level.levelTypeId, asOf);
  const range = await numericRange(tx, tenantId, 'levels', post.minLevelId, post.maxLevelId, asOf);
  if (
    typeof level.level !== 'number' ||
    level.level < range.low ||
    level.level > range.high ||
    (post.levelTypeId && post.levelTypeId !== level.levelTypeId)
  ) {
    throw new AppError('VALIDATION_FAILED', '职级不在职务允许区间内');
  }
}
