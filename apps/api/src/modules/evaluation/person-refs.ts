/**
 * 人员引用出口（设计 §5.1，DEC-331① / DEC-339②）：配置对象里引用的员工，按查看人当前的人员范围裁剪。B3 评审组成员首个使用，
 * B5（活动负责人）、C2（场次评委 / 跟场人）复用同一份，不各写一份。
 * - 范围内：返回 ID 与姓名、工号（各自按员工信息的字段查看权）；
 * - 范围外：照原站显示姓名、计入人数，只返回 ID 与姓名，不带工号、邮箱、手机、部门等其他字段；用这个 ID 查人员详情仍与不存在
 *   一样 404（人员详情走人员模块自己的范围，本 helper 不放宽）；
 * - 查看人没有员工信息的对象查看权：只返回 ID；姓名没有字段查看权：范围内外都不带姓名（同 F-057 范围外上级姓名）；
 * - 写入：前端按完整 ID 集合保存，服务端只对**新增**的 ID 校验存在且在人员范围内（范围外与不存在同一 404）；原有范围外 ID
 *   原样提交视为保留，不重新校验；删除不要求在范围内。
 * 人员范围与字段权在路由层按当前权限解析（首次与幂等重放都重新解析，DEC-067），事务内只用解析结果。
 */
import { sql, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT } from '@italent/domain';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
  scopeSql,
} from '../permission/module-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { requestScope, type ModuleScope } from '../permission/module-route-access.js';
import { rowsOf } from './access.js';

/** 查看人对员工信息的访问：范围为 null = 没有对象查看权（只给 ID）。 */
export interface PersonRefAccess {
  readonly scope: ModuleScope | null;
  /** 员工信息上可见的字段；undefined = 全部。 */
  readonly fields: ReadonlySet<string> | undefined;
}

export interface PersonRefView {
  readonly name?: string;
  readonly code?: string;
}

const visibleField = (fields: ReadonlySet<string> | undefined, field: string) =>
  fields === undefined || fields.has(field);

const uuidList = (ids: readonly string[]) => `{${[...new Set(ids)].join(',')}}`;

/** 路由层（每次请求，含幂等重放）解析：员工信息的查看权、人员范围与可见字段。 */
export async function personRefAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
): Promise<PersonRefAccess> {
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: PERSONNEL_OBJECT, fields: [] });
  if (!canView) return { scope: null, fields: new Set<string>() };
  // 披露分支，不是准入：查看权上一行已判定（无权不抛错、只给 ID），所以这里不走 objectContext 的抛错门禁
  return {
    scope: await requestScope(c, deps, ctx, PERSONNEL_OBJECT),
    fields: await getModuleViewableFields(deps, ctx, PERSONNEL_OBJECT),
  };
}

/**
 * 命令事务内的解析（写命令的复核点调用，首次执行、直接重放、失败后回查都经过）：查看权、人员范围、可见字段全部在事务内按当前
 * 授权重新解析；不用 requestScope（它按请求缓存，撤权后同一请求内仍是旧值）。同样是披露分支：无权不抛错，只给 ID。
 */
export async function personRefAccessInTransaction(
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  tx: Tx,
): Promise<PersonRefAccess> {
  const bound: TenantRouteDeps = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
  const canView = await bound.authorize({ ...ctx, action: 'object.view', resource: PERSONNEL_OBJECT, fields: [] });
  if (!canView) return { scope: null, fields: new Set<string>() };
  return {
    scope: await resolveModuleScopeInTransaction(bound, ctx, tx, PERSONNEL_OBJECT),
    fields: await getModuleViewableFieldsInTransaction(bound, ctx, PERSONNEL_OBJECT, tx),
  };
}

/** 一批员工里在人员范围内的（一条 SQL，分页前谓词同候选列表）。 */
export async function employeesInScope(tx: Tx, scope: ModuleScope, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const inScope = scopeSql(scope, { person: sql`e.id` });
  const found = rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT e.id FROM employment_employees e
      WHERE e.id = ANY(${uuidList(ids)}::uuid[]) AND ${inScope}`),
  );
  return new Set(found.map((row) => row.id));
}

/**
 * 写入：新增的员工 ID 必须存在且在人员范围内，不存在与范围外同一个 404；没有员工信息查看权 403。
 * 只传本次新增的 ID（集合里原有的保留，不重新校验可见性）。
 */
export async function assertNewPersonRefs(
  tx: Tx,
  access: PersonRefAccess,
  ids: readonly string[],
  label = '人员',
): Promise<void> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (!wanted.length) return;
  if (!access.scope) throw new AppError('FORBIDDEN', '无权查看员工信息', { reason: 'NO_EMPLOYEE_ACCESS' });
  const inScope = await employeesInScope(tx, access.scope, wanted);
  if (wanted.some((id) => !inScope.has(id))) throw new AppError('NOT_FOUND', `${label}不存在`);
}

/** 员工姓名与工号：姓名取员工信息最新版本、缺省员工主档（同 succession/read-sql loadPeople）；不按查看人裁剪，调用方负责。 */
export async function loadEmployees(
  tx: Tx,
  tenantId: string,
  ids: readonly string[],
): Promise<{ id: string; name: string; code: string }[]> {
  if (!ids.length) return [];
  return rowsOf<{ id: string; name: string; code: string }>(
    await tx.execute(sql`SELECT e.id, COALESCE(v.name, e.name) AS name, e.code
      FROM employment_employees e
      LEFT JOIN LATERAL (SELECT pv.name FROM personnel_employee_versions pv
        WHERE pv.tenant_id = e.tenant_id AND pv.employee_id = e.id ORDER BY pv.revision DESC LIMIT 1) v ON true
      WHERE e.tenant_id = ${tenantId}::uuid AND e.id = ANY(${uuidList(ids)}::uuid[])`),
  );
}

/** 呈现：员工 ID → 展示字段（范围内 姓名 + 工号；范围外 只有姓名）；没有对象查看权或查不到的只给 ID（不在结果里）。 */
export async function presentPersonRefs(
  tx: Tx,
  tenantId: string,
  access: PersonRefAccess,
  ids: readonly string[],
): Promise<Map<string, PersonRefView>> {
  const result = new Map<string, PersonRefView>();
  if (!ids.length || !access.scope) return result;
  const showName = visibleField(access.fields, 'name');
  const showCode = visibleField(access.fields, 'code');
  if (!showName && !showCode) return result;
  const inScope = await employeesInScope(tx, access.scope, ids);
  for (const row of await loadEmployees(tx, tenantId, ids)) {
    result.set(row.id, {
      ...(showName ? { name: row.name } : {}),
      ...(showCode && inScope.has(row.id) ? { code: row.code } : {}),
    });
  }
  return result;
}
