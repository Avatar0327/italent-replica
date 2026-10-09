/**
 * 任职资格的权限接入（DEC-080 单一权限模型；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §5.1；AGENTS §10）：
 * - 功能权限：对象的查看 / 新增 / 编辑 / 删除 + 写入口按钮，写入按载荷逐字段校验编辑权（含显式清空）；
 * - 数据范围：带资源集合的对象（分类、指标类型）读取 = 所属管理单元在范围内（“使用用户”按所属人）
 *   ∪（向下公开 ∧ 范围内有其下级组织）；写入只认前半段，仅因向下公开可见的写 403（QL_PUBLIC_DOWN_READONLY）。
 *   DEC-352（🟡 写权限待原站取证）：类别、级别、指标、标准、发展通道、编码规则（及随指标的等级描述）只放开查看——
 *   有功能 / 字段查看权即看得到全部，不按管理单元 / 创建人裁剪；新建、编辑、删除仍按管理单元（标准按所属类别、编码
 *   规则按看全部 ∪ 创建人）控制，范围外的写 403（QL_OUT_OF_SCOPE_READONLY）。层级、等级方案是字典（看全部 ∪ 创建人，
 *   DEC-121）。范围按对象所属应用 Qualification 解析（DEC-043），缺省为空；
 * - 引用校验统一一处（assertQualificationRefs）：评定活动、评价表、发展通道等引用类别 / 级别 / 指标 / 标准时，
 *   操作人须有被引用对象的查看权（DEC-352 起不再按范围），被引用对象须启用（只拦新引用；已引用后停用照常显示，
 *   同 DEC-281⑧）。
 *
 * qlReadable / qlStandardReadable / qualificationRefAccess / assertQualificationRefs 的签名在 PR-A 首个提交冻结，
 * 供 PR-B（评定配置）与 C1 / C2 引用（设计 §1.2）。
 */
import { sql, type Tx } from '@italent/db';
import { QUALIFICATION_OBJECTS, type QualificationObject } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields, scopeSql, trimModuleResponse } from '../permission/module-access.js';
import {
  button,
  hasCreatorScope,
  objectContext,
  requestScope,
  writeFields,
  type ModuleScope,
} from '../permission/module-route-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { readableSql, type PublicDownContext } from '../permission/public-down.js';

export type { ModuleScope, QualificationObject };
export type QualificationContext = ScopeBusinessContext;

export const QUALIFICATION_LABELS: Readonly<Record<QualificationObject, string>> = {
  categoryClass: '任职类别分类',
  category: '任职类别',
  layer: '层级',
  level: '任职级别',
  targetType: '指标类型',
  target: '指标',
  gradeScheme: '等级方案',
  targetGradeDescription: '指标等级描述',
  codingRule: '编码规则',
  standard: '任职资格标准',
  developmentChannel: '发展通道',
};

export const codeOf = (object: QualificationObject) => QUALIFICATION_OBJECTS[object].code;

const column = (alias: string, name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;

/**
 * 带资源集合对象的读取谓词（分页之前生效）：`scopeSql(owner)` ∪（`public_down` ∧ 向下公开）。别名指向带
 * owner_org_id / owner_id / public_down 三列的表（分类、类别、级别、指标类型、指标）。看全部时为 true。
 */
export function qlReadable(ctx: PublicDownContext, scope: ModuleScope, alias: string): SQL {
  return readableSql(ctx, scope, {
    org: column(alias, 'owner_org_id'),
    publicDown: column(alias, 'public_down'),
    creator: column(alias, 'owner_id'),
  });
}

/**
 * 标准的读取谓词：DEC-352 起有标准查看权即看得到全部，不再按所属类别的范围裁剪（签名冻结，参数保留）。别名指向
 * ql_standards。
 */
export function qlStandardReadable(_ctx: PublicDownContext, _scope: ModuleScope, _alias: string): SQL {
  return sql`true`;
}

/** DEC-352：只放开查看的对象——有功能 / 字段查看权即看得到全部，写入仍按管理单元。 */
export const OPEN_READ: ReadonlySet<QualificationObject> = new Set<QualificationObject>([
  'category',
  'level',
  'target',
  'targetGradeDescription',
  'codingRule',
  'standard',
  'developmentChannel',
]);

/** 某对象在查看人当前范围下的读取谓词：只放开查看的对象恒真（查看权由调用方判定），其余按 qlReadable。 */
export function qlViewable(
  object: QualificationObject,
  ctx: PublicDownContext,
  scope: ModuleScope,
  alias: string,
): SQL {
  return OPEN_READ.has(object) ? sql`true` : qlReadable(ctx, scope, alias);
}

/** 可被其他对象引用的任职资格对象（设计 §5.1 引用校验）。 */
export type QualificationRefObject = 'category' | 'level' | 'target' | 'standard';

export interface QualificationRefs {
  readonly categoryIds?: readonly string[];
  readonly levelIds?: readonly string[];
  readonly targetIds?: readonly string[];
  readonly standardIds?: readonly string[];
}

/**
 * 引用校验要用的权限：请求上下文 + 每类被引用对象的读取范围（按当前权限在事务外解析）；null 表示操作人没有该对象的
 * 查看权。标准的读取范围按任职类别对象解析（标准锚在类别上）。
 */
export interface QualificationRefAccess {
  readonly ctx: PublicDownContext;
  readonly scopes: Readonly<Partial<Record<QualificationRefObject, ModuleScope | null>>>;
}

const REF_OBJECTS: Readonly<Record<QualificationRefObject, QualificationObject>> = {
  category: 'category',
  level: 'level',
  target: 'target',
  standard: 'standard',
};

/** 解析引用校验所需的范围（对象查看权 → 范围）；标准额外要求类别的范围（锚点）。 */
export async function qualificationRefAccess(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  objects: readonly QualificationRefObject[],
): Promise<QualificationRefAccess> {
  const scopes: Partial<Record<QualificationRefObject, ModuleScope | null>> = {};
  for (const object of new Set(objects)) {
    const code = codeOf(REF_OBJECTS[object]);
    const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: code, fields: [] });
    if (!canView) {
      scopes[object] = null;
      continue;
    }
    // 标准没有自己的资源集合：读取范围取任职类别对象的（锚点），查看权仍按标准对象
    scopes[object] = await requestScope(c, deps, ctx, codeOf(object === 'standard' ? 'category' : object));
  }
  return { ctx, scopes };
}

const REF_TABLES: Readonly<Record<QualificationRefObject, string>> = {
  category: 'ql_categories',
  level: 'ql_levels',
  target: 'ql_targets',
  standard: 'ql_standards',
};

interface RefRow {
  readonly id: string;
  readonly enabled: boolean;
  readonly readable: boolean;
}

/**
 * 校验新引用（在调用方事务内，被引用行加 FOR SHARE，与其停用 / 删除串行）：
 * 没有查看权 403；不存在或不在读取范围内同一个 404；已停用 400（reason REFERENCE_DISABLED）。
 * 只传本次新增的引用；已有引用在对象停用后照常保留（DEC-281⑧）。
 */
export async function assertQualificationRefs(
  tx: Tx,
  access: QualificationRefAccess,
  refs: QualificationRefs,
): Promise<void> {
  const wanted: [QualificationRefObject, readonly string[] | undefined][] = [
    ['category', refs.categoryIds],
    ['level', refs.levelIds],
    ['target', refs.targetIds],
    ['standard', refs.standardIds],
  ];
  for (const [object, ids] of wanted) {
    const unique = [...new Set((ids ?? []).map((value) => value.toLowerCase()))];
    if (!unique.length) continue;
    const label = QUALIFICATION_LABELS[REF_OBJECTS[object]];
    const scope = access.scopes[object];
    if (scope === null) throw new AppError('FORBIDDEN', `无权查看${label}`);
    if (!scope) throw new Error(`未解析${label}的引用范围`);
    const readable = qlViewable(REF_OBJECTS[object], access.ctx, scope, 'r');
    const result = await tx.execute(sql`SELECT r.id, r.enabled, (${readable}) AS readable
      FROM ${sql.identifier(REF_TABLES[object])} r
      WHERE r.tenant_id = ${access.ctx.tenantId}::uuid AND r.id = ANY(${`{${unique.join(',')}}`}::uuid[])
      ORDER BY r.id FOR SHARE OF r`);
    const rows = new Map(rowsOf<RefRow>(result).map((row) => [row.id, row]));
    for (const id of unique) {
      const row = rows.get(id);
      if (!row || row.readable !== true) throw new AppError('NOT_FOUND', `${label}不存在`);
      if (!row.enabled) {
        throw new AppError('VALIDATION_FAILED', `${label}已停用，不能引用`, { reason: 'REFERENCE_DISABLED', id });
      }
    }
  }
}

export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

/**
 * 对象的范围锚点类型：带资源集合（owner 列组）、字典（创建人）、标准（写锚在所属类别上）。`open` / `openDictionary`
 * 是只放开查看的带资源集合对象与字典（DEC-352）：读取恒真，写入同 owned / dictionary。
 */
export type AnchorKind = 'owned' | 'open' | 'dictionary' | 'openDictionary' | 'standard';

export const ANCHOR: Readonly<Record<QualificationObject, AnchorKind>> = {
  categoryClass: 'owned',
  category: 'open',
  layer: 'dictionary',
  level: 'open',
  targetType: 'owned',
  target: 'open',
  gradeScheme: 'dictionary',
  targetGradeDescription: 'open',
  codingRule: 'openDictionary',
  standard: 'standard',
  developmentChannel: 'standard',
};

/**
 * 某行在查看人当前范围下的可写 / 可读谓词（别名 t 指向对象表）。可写只认数据范围（所属管理单元、“使用用户”按所属人；
 * 字典按创建人）；可读另加向下公开（字典与可写相同）。标准经 ql_categories 锚在类别上。
 */
export function accessSql(ctx: PublicDownContext, scope: ModuleScope, kind: AnchorKind, alias = 't') {
  if (kind === 'dictionary' || kind === 'openDictionary') {
    const own = scopeSql(scope, { creator: column(alias, 'created_by') });
    return { editable: own, readable: kind === 'openDictionary' ? sql`true` : own };
  }
  if (kind === 'owned' || kind === 'open') {
    return {
      editable: scopeSql(scope, { org: column(alias, 'owner_org_id'), creator: column(alias, 'owner_id') }),
      readable: kind === 'open' ? sql`true` : qlReadable(ctx, scope, alias),
    };
  }
  const anchored = (predicate: SQL) => sql`EXISTS (SELECT 1 FROM ql_categories qa
    WHERE qa.tenant_id = ${column(alias, 'tenant_id')} AND qa.id = ${column(alias, 'category_id')} AND ${predicate})`;
  return {
    editable: anchored(scopeSql(scope, { org: sql`qa.owner_org_id`, creator: sql`qa.owner_id` })),
    readable: qlStandardReadable(ctx, scope, alias),
  };
}

export type Access = 'edit' | 'view' | 'none';

/** 读取：不可见与不存在同为 404。 */
export function requireReadable(access: Access, object: QualificationObject): void {
  if (access === 'none') throw new AppError('NOT_FOUND', `${QUALIFICATION_LABELS[object]}不存在`);
}

/**
 * 写入：不可见 404；看得到但不在写范围内 403——只放开查看的对象（DEC-352）为 QL_OUT_OF_SCOPE_READONLY，其余是
 * 仅因向下公开可见（设计 §5.1，QL_PUBLIC_DOWN_READONLY）。
 */
export function requireEditable(access: Access, object: QualificationObject): void {
  requireReadable(access, object);
  if (access !== 'view') return;
  if (OPEN_READ.has(object)) {
    throw new AppError('FORBIDDEN', `${QUALIFICATION_LABELS[object]}不在你的管理范围内，只能查看`, {
      reason: 'QL_OUT_OF_SCOPE_READONLY',
    });
  }
  throw new AppError('FORBIDDEN', `${QUALIFICATION_LABELS[object]}由上级组织向下公开，只能查看与选用`, {
    reason: 'QL_PUBLIC_DOWN_READONLY',
  });
}

export function qualificationContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: QualificationObject,
  operation: 'view' | 'create' | 'update' | 'delete' = 'view',
  expectedRevision = 0,
): Promise<QualificationContext> {
  return objectContext(c, deps, codeOf(object), operation, expectedRevision);
}

const BUTTON_LEVEL = { create: 'list', update: 'detail', delete: 'detail' } as const;

/** 写入口：数据操作权 + 按钮（REQ-PRM-001 R6），在命令台账之前校验，首次与幂等重放都经过这里。 */
export async function qualificationWriteContext(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  object: QualificationObject,
  operation: 'create' | 'update' | 'delete',
  expectedRevision: number,
): Promise<QualificationContext> {
  const ctx = await qualificationContext(c, deps, object, operation, expectedRevision);
  await button(deps, ctx, codeOf(object), operation, BUTTON_LEVEL[operation]);
  return ctx;
}

/** 不是写字段的控制键：确认框、引入条目、所属管理单元的选择（系统字段，由 ownerOf 校验，DEC-339）。 */
const CONTROLS: ReadonlySet<string> = new Set(['confirmOverwrite', 'items', 'ownerOrgId']);

/** 载荷字段编辑权（含显式清空），键即字段编码。 */
export function checkWriteFields(
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: QualificationObject,
  operation: 'create' | 'update',
  payload: Readonly<Record<string, unknown>>,
) {
  const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => !CONTROLS.has(key)));
  return writeFields(deps, ctx, codeOf(object), operation, fields);
}

export const qualificationScope = (
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: QualificationObject,
) => requestScope(c, deps, ctx, codeOf(object === 'standard' || object === 'developmentChannel' ? 'category' : object));

/** 查看人当前对某对象的可见字段（undefined = 全部；没有查看权为空集）。 */
export async function objectFields(deps: TenantRouteDeps, ctx: QualificationContext, object: QualificationObject) {
  const canView = await deps.authorize({ ...ctx, action: 'object.view', resource: codeOf(object), fields: [] });
  if (!canView) return new Set<string>() as ReadonlySet<string>;
  return getModuleViewableFields(deps, ctx, codeOf(object));
}

export const fieldVisible = (fields: ReadonlySet<string> | undefined, field: string) =>
  fields === undefined || fields.has(field);

export const trimQualification = <T extends object>(
  deps: TenantRouteDeps,
  ctx: QualificationContext,
  object: QualificationObject,
  value: T[],
): Promise<Partial<T>[]> => trimModuleResponse(deps, ctx, codeOf(object), value) as Promise<Partial<T>[]>;

/** 列表信封：查看人在该对象上有没有任何数据范围（字典看看全部或创建人）。 */
export function listEnvelope(page: { page: number; pageSize: number }, scope: ModuleScope, kind: AnchorKind) {
  const open = kind === 'open' || kind === 'openDictionary' || kind === 'standard';
  const hasDataPermission =
    open || scope.all || (kind === 'dictionary' ? hasCreatorScope(scope) : scope.hasDataPermission);
  return { page: page.page, pageSize: page.pageSize, hasDataPermission };
}
