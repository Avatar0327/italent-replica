/**
 * 职务职级图谱的五源对象整体校验与源数据投影（F-474-7b；设计 §4.4）。
 * 图谱把整个租户的职务体系汇总进共享快照，所以读 / 生成 / 重放前，调用者对五个源对象必须同时有：对象查看权、
 * 看全部范围、下表全部字段的查看权；缺任何一项统一 403，不披露是哪一项、哪个对象。字段清单即生成器的投影清单，
 * 加读一个字段必须同时加进这里的授权清单。
 */
import { sql, type Tx } from '@italent/db';
import { buttonResource, MODULE_OBJECTS, type JobGraphInput, type JobGraphRecord } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  resolveModuleScope,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { columnName, jobTables, type JobKind } from './metadata.js';
import { rowsOf } from './store.js';

export const GRAPH_OBJECT = MODULE_OBJECTS.jobGraph.code;
const COMMON = ['id', 'name', 'enabled', 'startDate', 'stopDate'];
interface GraphSource {
  readonly input: keyof JobGraphInput;
  readonly kind: JobKind;
  readonly code: string;
  readonly fields: readonly string[];
}
export const GRAPH_SOURCES: readonly GraphSource[] = [
  { input: 'grades', kind: 'grades', code: MODULE_OBJECTS.jobGrade.code, fields: [...COMMON, 'grade'] },
  { input: 'levelTypes', kind: 'level-types', code: MODULE_OBJECTS.jobLevelType.code, fields: COMMON },
  {
    input: 'levels',
    kind: 'levels',
    code: MODULE_OBJECTS.jobLevel.code,
    fields: [...COMMON, 'levelTypeId', 'minGradeId', 'maxGradeId'],
  },
  { input: 'sequences', kind: 'sequences', code: MODULE_OBJECTS.jobSequence.code, fields: [...COMMON, 'parentId'] },
  {
    input: 'posts',
    kind: 'posts',
    code: MODULE_OBJECTS.jobPost.code,
    fields: [...COMMON, 'sequenceId', 'minLevelId', 'maxLevelId', 'displayOrder', 'code'],
  },
];

type Deps = Pick<TenantRouteDeps, 'authorize' | 'db' | 'clock'>;

const authorizerOf = (deps: Deps, tx?: Tx) => (tx ? authorizeInTransaction(deps.authorize, tx) : deps.authorize);

async function sourcesAllowed(deps: Deps, ctx: TenantContext, tx?: Tx) {
  const authorize = authorizerOf(deps, tx);
  const bound = { ...deps, authorize };
  const view = (resource: string) => authorize({ ...ctx, action: 'object.view', resource, fields: [] });
  if (!(await view(GRAPH_OBJECT))) return false;
  for (const source of GRAPH_SOURCES) {
    if (!(await view(source.code))) return false;
    const scope = tx
      ? await resolveModuleScopeInTransaction(bound, ctx, tx, source.code)
      : await resolveModuleScope(bound, ctx, undefined, source.code);
    if (!scope.all) return false;
    const fields = tx
      ? await getModuleViewableFieldsInTransaction(bound, ctx, source.code, tx)
      : await getModuleViewableFields(bound, ctx, source.code);
    if (fields && !source.fields.every((field) => fields.has(field))) return false;
  }
  return true;
}

/** 读接口和命令重放共用；`tx` 给定时在该事务内判定（命令台账的重放出口）。 */
export async function requireGraphAccess(deps: Deps, ctx: TenantContext, tx?: Tx) {
  if (!(await sourcesAllowed(deps, ctx, tx))) throw new AppError('FORBIDDEN', '无权访问职务职级图谱');
}

/** 生成快照：在读权限之上再要求图谱「生成」按钮（列表层）；同样统一 403。 */
export async function requireGraphRebuild(deps: Deps, ctx: TenantContext, tx?: Tx) {
  await requireGraphAccess(deps, ctx, tx);
  const resource = buttonResource(GRAPH_OBJECT, 'rebuild', 'list');
  if (!(await authorizerOf(deps, tx)({ ...ctx, action: 'object.button', resource })))
    throw new AppError('FORBIDDEN', '无权访问职务职级图谱');
}

/** 取 asOf 时点有效的最新版本，只投影授权清单里的列（停用的保留 enabled 标志，已过期 / 未开始的不取）。 */
export async function loadGraphInput(tx: Tx, tenantId: string, asOf: string): Promise<JobGraphInput> {
  const input = {} as Record<keyof JobGraphInput, JobGraphRecord[]>;
  for (const source of GRAPH_SOURCES) {
    const columns = source.fields.map((field) =>
      field === 'id'
        ? sql`v.object_id AS "id"`
        : field === 'startDate' || field === 'stopDate'
          ? sql`v.${sql.identifier(columnName(field))}::text AS ${sql.identifier(field)}`
          : sql`v.${sql.identifier(columnName(field))} AS ${sql.identifier(field)}`,
    );
    input[source.input] = rowsOf<JobGraphRecord>(
      await tx.execute(sql`
      SELECT ${sql.join(columns, sql`, `)} FROM (
        SELECT DISTINCT ON (object_id) * FROM ${sql.identifier(jobTables(source.kind).versionTable)}
        WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
        ORDER BY object_id, start_date DESC, version_no DESC
      ) v WHERE v.stop_date >= ${asOf}::date`),
    );
  }
  return input;
}
