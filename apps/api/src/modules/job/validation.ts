import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { jobTables, type JobKind } from './metadata.js';
import { loadJobObject, type JobRecord } from './read-model.js';
import { rowsOf } from './store.js';
import type { JobFields, JobWriteContext } from './types.js';

const targets: Readonly<Record<string, JobKind>> = {
  layerId: 'layers',
  levelTypeId: 'level-types',
  minGradeId: 'grades',
  maxGradeId: 'grades',
  minLevelId: 'levels',
  maxLevelId: 'levels',
  sequenceId: 'sequences',
  professionalLineId: 'professional-lines',
  postId: 'posts',
  standardPositionId: 'positions',
  directParentId: 'positions',
  dottedParentId: 'positions',
};
export const SEQUENCE_ANCESTOR_FIELDS = [
  'firstSequenceId',
  'secondSequenceId',
  'thirdSequenceId',
  'fourthSequenceId',
  'fifthSequenceId',
  'sixthSequenceId',
  'seventhSequenceId',
  'eighthSequenceId',
  'ninthSequenceId',
  'tenthSequenceId',
] as const;

export async function validateJobFields(
  tx: Tx,
  ctx: JobWriteContext,
  kind: JobKind,
  objectId: string,
  fields: JobFields,
): Promise<JobFields> {
  const persisted = positionParents(fields, kind);
  const resolved = new Map<string, JobRecord>();
  for (const [field, target] of Object.entries(targets)) {
    const id = persisted[field];
    if (typeof id === 'string') resolved.set(field, await requiredJob(tx, ctx.tenantId, target, id, fields.startDate));
  }
  checkScoreRange(persisted);
  checkRanges(persisted, resolved);
  if (kind === 'positions') {
    await validateOrganizationReference(tx, ctx, fields);
    await validatePositionHierarchy(tx, ctx, objectId, persisted);
  }
  if (kind === 'sequences' || kind === 'professional-lines') {
    return { ...persisted, ...(await treeFields(tx, ctx, kind, objectId, persisted)) };
  }
  return persisted;
}

async function validateOrganizationReference(tx: Tx, ctx: JobWriteContext, fields: JobFields): Promise<void> {
  const [organization] = rowsOf<{ enabled: boolean; stopDate: string }>(
    await tx.execute(sql`
      SELECT enabled, stop_date::text AS "stopDate" FROM org_versions
      WHERE tenant_id = ${ctx.tenantId} AND org_id = ${fields.orgId}::uuid AND start_date <= ${fields.startDate}::date
      ORDER BY start_date DESC, version_no DESC LIMIT 1
    `),
  );
  if (!organization?.enabled || organization.stopDate < fields.startDate) {
    throw invalid('orgId', '所属组织不存在、未生效、已停用或不在当前租户');
  }
}

export function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', message, { field });
}

export async function requiredJob(tx: Tx, tenantId: string, kind: JobKind, id: string, asOf: string) {
  const record = await loadJobObject(tx, tenantId, kind, id, asOf);
  if (!record?.enabled) throw invalid(kind, '引用对象不存在、未生效、已停用或不在当前租户');
  return record;
}

function positionParents(fields: JobFields, kind: JobKind): JobFields {
  if (kind !== 'positions') return fields;
  const parents = fields.parents as
    { admin?: { parentId: string | null; sequence?: number | null }; dotted?: { parentId: string | null } } | undefined;
  const dotted = parents?.dotted as { parentId: string | null; sequence?: number | null } | undefined;
  const { parents: _parents, ...remaining } = fields;
  return {
    ...remaining,
    directParentId: parents?.admin?.parentId ?? null,
    directSequence: parents?.admin?.sequence ?? null,
    dottedParentId: dotted?.parentId ?? null,
    dottedSequence: dotted?.sequence ?? null,
  };
}

function checkScoreRange(fields: JobFields): void {
  if (
    typeof fields.scoreLow === 'number' &&
    typeof fields.scoreHigh === 'number' &&
    fields.scoreLow > fields.scoreHigh
  ) {
    throw invalid('scoreLow', '评估分下限不得大于上限');
  }
}

function checkRanges(fields: JobFields, refs: Map<string, JobRecord>): void {
  for (const [lower, upper, value] of [
    ['minGradeId', 'maxGradeId', 'grade'],
    ['minLevelId', 'maxLevelId', 'level'],
  ] as const) {
    const minimum = refs.get(lower);
    const maximum = refs.get(upper);
    if (minimum && typeof minimum[value] !== 'number') throw invalid(lower, '区间边界必须有级别数值');
    if (maximum && typeof maximum[value] !== 'number') throw invalid(upper, '区间边界必须有级别数值');
    if (minimum && maximum && Number(minimum[value]) > Number(maximum[value])) {
      throw invalid(lower, '最低值不得大于最高值');
    }
  }
  const minLevel = refs.get('minLevelId');
  const maxLevel = refs.get('maxLevelId');
  if (minLevel && maxLevel && minLevel.levelTypeId !== maxLevel.levelTypeId) {
    throw invalid('minLevelId', '最低与最高职级必须属于同一职级类别');
  }
  for (const level of [minLevel, maxLevel]) {
    if (level && fields.levelTypeId && level.levelTypeId !== fields.levelTypeId) {
      throw invalid('levelTypeId', '职级区间必须属于所选职级类别');
    }
  }
}

export async function treeFields(
  tx: Tx,
  ctx: JobWriteContext,
  kind: 'sequences' | 'professional-lines',
  objectId: string,
  fields: JobFields,
): Promise<Record<string, unknown>> {
  const ancestors: string[] = [objectId];
  let parentId = fields.parentId;
  while (typeof parentId === 'string') {
    if (ancestors.length >= 200) throw new AppError('PAYLOAD_TOO_LARGE', '层级超出单次校验处理上限');
    if (ancestors.includes(parentId)) throw invalid('parentId', '树形主数据不得形成环');
    ancestors.unshift(parentId);
    if (kind === 'sequences' && ancestors.length > 10) throw invalid('parentId', '职务序列最多十级');
    const parent = await requiredJob(tx, ctx.tenantId, kind, parentId, fields.startDate);
    await assertNoFutureAncestorMove(tx, ctx, kind, parent, fields);
    parentId = parent.parentId;
  }
  const result: Record<string, unknown> = { level: ancestors.length };
  if (kind === 'sequences') {
    SEQUENCE_ANCESTOR_FIELDS.forEach((field, index) => {
      result[field] = ancestors[index] ?? null;
    });
  }
  return result;
}

async function assertNoFutureAncestorMove(
  tx: Tx,
  ctx: JobWriteContext,
  kind: 'sequences' | 'professional-lines',
  parent: JobRecord,
  fields: JobFields,
): Promise<void> {
  const [futureMove] = rowsOf(
    await tx.execute(sql`
      SELECT 1 FROM (
        SELECT DISTINCT ON (start_date) parent_id FROM ${sql.identifier(jobTables(kind).versionTable)}
        WHERE tenant_id = ${ctx.tenantId} AND object_id = ${parent.id}::uuid
          AND start_date > ${fields.startDate}::date AND start_date <= ${fields.stopDate}::date
        ORDER BY start_date, version_no DESC
      ) planned WHERE parent_id IS DISTINCT FROM ${parent.parentId ?? null}::uuid LIMIT 1
    `),
  );
  // DEC-072 / Q-M0-06：先处理祖先已排定的结构变更，防止新下级缓存的祖先路径在未来失真。
  // 后续版本仅改名或改码时，parent_id 不变，不影响当前缓存路径。
  if (futureMove) {
    throw new AppError('JOB_FUTURE_VERSION_EXISTS', '祖先已有后续层级变更，请先处理后续版本');
  }
}

async function validatePositionHierarchy(tx: Tx, ctx: JobWriteContext, objectId: string, fields: JobFields) {
  for (const dimension of ['directParentId', 'dottedParentId'] as const) {
    const visited = new Set([objectId]);
    let parentId = fields[dimension];
    while (typeof parentId === 'string') {
      if (visited.size >= 200) throw new AppError('PAYLOAD_TOO_LARGE', '职位层级超出单次校验处理上限');
      if (visited.has(parentId)) throw invalid(dimension, '职位汇报关系不得形成环');
      visited.add(parentId);
      const parent = await requiredJob(tx, ctx.tenantId, 'positions', parentId, fields.startDate);
      parentId = parent[dimension];
    }
  }
}

export async function validateJobAssignment(
  tx: Tx,
  tenantId: string,
  input: { postId: string; levelId?: string; gradeId?: string; asOf: string },
): Promise<{ valid: true }> {
  const post = await requiredJob(tx, tenantId, 'posts', input.postId, input.asOf);
  if (typeof post.levelTypeId === 'string') {
    await requiredJob(tx, tenantId, 'level-types', post.levelTypeId, input.asOf);
  }
  const level = input.levelId ? await requiredJob(tx, tenantId, 'levels', input.levelId, input.asOf) : undefined;
  if (level) {
    if (typeof level.levelTypeId === 'string' && level.levelTypeId !== post.levelTypeId) {
      await requiredJob(tx, tenantId, 'level-types', level.levelTypeId, input.asOf);
    }
    if (post.levelTypeId && level.levelTypeId !== post.levelTypeId) throw invalid('levelId', '职级类别与职务不符');
    await checkSelectedRange(tx, tenantId, post, level, 'levels', 'level', input.asOf);
  }
  if (input.gradeId) {
    const grade = await requiredJob(tx, tenantId, 'grades', input.gradeId, input.asOf);
    await checkSelectedRange(tx, tenantId, post, grade, 'grades', 'grade', input.asOf);
    if (level) await checkSelectedRange(tx, tenantId, level, grade, 'grades', 'grade', input.asOf);
  }
  return { valid: true };
}

async function checkSelectedRange(
  tx: Tx,
  tenantId: string,
  owner: JobRecord,
  selected: JobRecord,
  kind: 'levels' | 'grades',
  value: 'level' | 'grade',
  asOf: string,
): Promise<void> {
  const suffix = value === 'level' ? 'LevelId' : 'GradeId';
  const minimumId = owner[`min${suffix}`];
  const maximumId = owner[`max${suffix}`];
  if (typeof selected[value] !== 'number') throw invalid(`${value}Id`, '所选对象缺少级别数值');
  if (!minimumId && !maximumId) return;
  for (const [id, lower] of [
    [minimumId, true],
    [maximumId, false],
  ] as const) {
    if (typeof id !== 'string') continue;
    const bound = await requiredJob(tx, tenantId, kind, id, asOf);
    if (typeof bound[value] !== 'number') throw invalid(`${value}Id`, '区间边界缺少级别数值');
    if (lower ? Number(selected[value]) < Number(bound[value]) : Number(selected[value]) > Number(bound[value])) {
      throw invalid(`${value}Id`, '所选值不在允许区间内');
    }
  }
}
