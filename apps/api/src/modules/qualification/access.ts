/**
 * 任职资格的权限接入（DEC-080 单一权限模型；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §5.1；AGENTS §10）：
 * - 功能权限：对象的查看 / 新增 / 编辑 / 删除 + 写入口按钮，写入按载荷逐字段校验编辑权（含显式清空）；
 * - 数据范围：带资源集合的对象（分类、类别、级别、指标类型、指标）读取 = 所属管理单元在范围内（“使用用户”按所属人）
 *   ∪（向下公开 ∧ 范围内有其下级组织）；写入只认前半段，仅因向下公开可见的写 403（QL_PUBLIC_DOWN_READONLY）。
 *   标准的可见性锚在所属类别上。层级、等级方案、编码规则是字典（看全部 ∪ 创建人，DEC-121）。
 *   范围按对象所属应用 Qualification 解析（DEC-043），缺省为空；
 * - 引用校验统一一处（assertQualificationRefs）：评定活动、评价表、发展通道等引用类别 / 级别 / 指标 / 标准时，
 *   被引用对象须在操作人读取范围内且启用（只拦新引用；已引用后停用照常显示，同 DEC-281⑧）。
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
import { requestScope, type ModuleScope } from '../permission/module-route-access.js';
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

/** 标准的读取谓词：所属类别可读（标准锚在类别上，设计 §5.1）。别名指向 ql_standards。 */
export function qlStandardReadable(ctx: PublicDownContext, scope: ModuleScope, alias: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ql_categories qc_anchor WHERE qc_anchor.tenant_id = ${column(alias, 'tenant_id')}
    AND qc_anchor.id = ${column(alias, 'category_id')} AND ${qlReadable(ctx, scope, 'qc_anchor')})`;
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
    const readable =
      object === 'standard' ? qlStandardReadable(access.ctx, scope, 'r') : qlReadable(access.ctx, scope, 'r');
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
