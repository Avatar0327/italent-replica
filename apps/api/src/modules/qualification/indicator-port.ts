/**
 * QualificationIndicatorPort 的实现与登记（R3-T02 设计 §6.2 (1)，DEC-317④、DEC-320⑥，Q-T02-16 ①；拆分方案 C1-3）。
 * 可信端口：在调用方租户事务内执行（RLS 保证只读到当前租户），有界（单次 ≤ 500），**不做权限判断与字段裁剪**——
 * 盘点评估人读指标是业务必须，授权由调用方按自己的业务关系完成（同 talent/port.ts）。列表方法在分页之前接收调用方给出的
 * 范围谓词（qualificationReadableSql 生成，引用别名 t）。返回值各层冻结（readonly）：同一份数据交给多个调用方。
 *
 * 口径（设计未写、按最小影响取，PR 描述列出 🟡）：
 * - 标准停用不影响读取（已引用后停用照常显示，DEC-281⑧）；指标停用照样返回并带 enabled=false，由调用方判断；
 * - targetTypePath = 指标所属类型从根到本级的名称；filter.targetTypeIds 含下级类型（选一个类型即取其下全部指标），
 *   与 targetIds 同时给取交集，给了空数组表示什么都不要；
 * - 列表方法只列启用的类型 / 指标（候选用于新引用），按顺序号、编码；
 * - 一列指标超过 500 个抛错而不是静默截断。
 */
import { sql, type Tx } from '@italent/db';
import {
  registerQualificationIndicatorPort,
  type QualificationIndicator,
  type QualificationIndicatorOutcome,
  type QualificationIndicatorPort,
  type QualificationListScope,
} from '@italent/domain';
import { is, SQL } from 'drizzle-orm';
import { qlViewable, type ModuleScope } from './access.js';
import { assertIsoDate, currentQualification, normalizedUuid } from './current.js';
import type { PublicDownContext } from '../permission/public-down.js';

export const QUALIFICATION_PORT_LIMIT = 500;

const rowsOf = <T>(result: unknown): T[] => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
const uuidArray = (ids: readonly string[]) => `{${ids.join(',')}}`;

/** 调用方的范围谓词：必须是 SQL，别名 t 指向指标类型 / 指标表；其他类型一律拒绝（fail-closed）。 */
function scopePredicate(scope: QualificationListScope): SQL {
  if (!is(scope, SQL)) throw new TypeError('范围谓词必须是 SQL（用 qualificationReadableSql 生成，或传 sql`true`）');
  return scope;
}

function pageOf(page: { limit: number; offset: number }): void {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > QUALIFICATION_PORT_LIMIT) {
    throw new RangeError(`limit 必须是 1～${QUALIFICATION_PORT_LIMIT} 的整数`);
  }
  if (!Number.isInteger(page.offset) || page.offset < 0) throw new RangeError('offset 必须是非负整数');
}

/**
 * 供调用方（如 R3-T04 模板管理员）生成列表方法的分页前范围谓词：指标类型按其所属管理单元 / 向下公开裁剪；
 * 指标是只放开查看的对象（DEC-352），恒真。谓词引用别名 t。
 */
export function qualificationReadableSql(
  ctx: PublicDownContext,
  scope: ModuleScope,
  object: 'targetType' | 'target',
): SQL {
  return qlViewable(object, ctx, scope, 't');
}

interface DetailRow {
  readonly detail_id: string;
  readonly detail_target_value: string | null;
  readonly weight: string | null;
  readonly target_id: string;
  readonly code: string;
  readonly name: string;
  readonly type_id: string;
  readonly eval_mode: 'score' | 'grade';
  readonly grade_scheme_id: string | null;
  readonly enabled: boolean;
}
interface AbilityRow {
  readonly detail_id: string;
  readonly content: string;
  readonly target_value: string | null;
  readonly target_grade_id: string | null;
}
interface ChainRow {
  readonly start_id: string;
  readonly id: string;
  readonly name: string;
}

/** 指标类型从本级到根的链（含本级，最深 20 层的防御上限），按 start_id 归并为 { 名称自根到本级, 链上 id }。 */
async function typeChains(tx: Tx, tenantId: string, typeIds: readonly string[]) {
  const chains = new Map<string, { names: string[]; ids: string[] }>();
  if (!typeIds.length) return chains;
  const result = rowsOf<ChainRow>(
    await tx.execute(sql`WITH RECURSIVE chain(start_id, id, parent_id, name, depth) AS (
        SELECT id, id, parent_id, name, 0 FROM ql_target_types
        WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${uuidArray(typeIds)}::uuid[])
      UNION ALL
        SELECT c.start_id, p.id, p.parent_id, p.name, c.depth + 1 FROM chain c
        JOIN ql_target_types p ON p.tenant_id = ${tenantId}::uuid AND p.id = c.parent_id
        WHERE c.depth < 20)
      SELECT start_id, id, name FROM chain ORDER BY start_id, depth DESC`),
  );
  for (const row of result) {
    const chain = chains.get(row.start_id) ?? { names: [], ids: [] };
    chain.names.push(row.name);
    chain.ids.push(row.id);
    chains.set(row.start_id, chain);
  }
  return chains;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

async function indicators(
  tx: Tx,
  tenantId: string,
  employeeId: string,
  asOf: string,
  filter?: { readonly targetTypeIds?: readonly string[]; readonly targetIds?: readonly string[] },
): Promise<QualificationIndicatorOutcome> {
  const tenant = normalizedUuid(tenantId, '租户 ID');
  const typeFilter = filter?.targetTypeIds?.map((id) => normalizedUuid(id, '指标类型 ID'));
  const targetFilter = filter?.targetIds?.map((id) => normalizedUuid(id, '指标 ID'));
  const current = await currentQualification(tx, tenant, employeeId, assertIsoDate(asOf));
  if (!current) return { ok: false, reason: 'no_current_qualification' };

  const [standard] = rowsOf<{ id: string; level_ids: string[] }>(
    await tx.execute(sql`SELECT id, level_ids FROM ql_standards
      WHERE tenant_id = ${tenant}::uuid AND category_id = ${current.categoryId}::uuid`),
  );
  if (!standard) return { ok: false, reason: 'no_standard' };
  if (!standard.level_ids.includes(current.levelId)) return { ok: false, reason: 'level_not_in_standard' };

  const details = rowsOf<DetailRow>(
    await tx.execute(sql`SELECT d.id AS detail_id, d.target_value AS detail_target_value, d.weight,
        t.id AS target_id, t.code, t.name, t.type_id, t.eval_mode, t.grade_scheme_id, t.enabled
      FROM ql_standard_details d
      JOIN ql_targets t ON t.tenant_id = d.tenant_id AND t.id = d.target_id
      WHERE d.tenant_id = ${tenant}::uuid AND d.standard_id = ${standard.id}::uuid AND d.level_id = ${current.levelId}::uuid
        ${targetFilter ? sql`AND t.id = ANY(${uuidArray(targetFilter)}::uuid[])` : sql``}
      ORDER BY t.display_order, t.code, t.id
      LIMIT ${QUALIFICATION_PORT_LIMIT + 1}`),
  );
  if (details.length > QUALIFICATION_PORT_LIMIT) {
    throw new RangeError(`一个级别的指标超过 ${QUALIFICATION_PORT_LIMIT} 个，超出端口上限`);
  }
  const chains = await typeChains(tx, tenant, [...new Set(details.map((row) => row.type_id))]);
  const kept = details.filter((row) => {
    if (!typeFilter) return true;
    const ids = chains.get(row.type_id)?.ids ?? [row.type_id];
    return typeFilter.some((id) => ids.includes(id));
  });
  const abilities = new Map<string, AbilityRow[]>();
  if (kept.length) {
    const found = rowsOf<AbilityRow>(
      await tx.execute(sql`SELECT detail_id, content, target_value, target_grade_id FROM ql_ability_details
        WHERE tenant_id = ${tenant}::uuid AND detail_id = ANY(${uuidArray(kept.map((row) => row.detail_id))}::uuid[])
        ORDER BY detail_id, display_order, id`),
    );
    for (const ability of found)
      abilities.set(ability.detail_id, [...(abilities.get(ability.detail_id) ?? []), ability]);
  }
  const data: QualificationIndicator[] = kept.map((row) => ({
    targetId: row.target_id,
    code: row.code,
    name: row.name,
    targetTypeId: row.type_id,
    targetTypePath: chains.get(row.type_id)?.names ?? [],
    evalMode: row.eval_mode,
    gradeSchemeId: row.grade_scheme_id,
    weight: row.weight === null ? null : Number(row.weight),
    targetValue: row.detail_target_value,
    abilities: (abilities.get(row.detail_id) ?? []).map((ability) => ({
      content: ability.content,
      targetValue: ability.target_value,
      targetGradeId: ability.target_grade_id,
    })),
    enabled: row.enabled,
  }));
  return deepFreeze({ ok: true, categoryId: current.categoryId, levelId: current.levelId, data });
}

async function listTargetTypes(
  tx: Tx,
  tenantId: string,
  scope: QualificationListScope,
  page: { limit: number; offset: number },
) {
  pageOf(page);
  const predicate = scopePredicate(scope);
  const found = rowsOf<{ id: string; name: string; parent_id: string | null }>(
    await tx.execute(sql`SELECT t.id, t.name, t.parent_id FROM ql_target_types t
      WHERE t.tenant_id = ${normalizedUuid(tenantId, '租户 ID')}::uuid AND t.enabled AND (${predicate})
      ORDER BY t.display_order, t.code, t.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return deepFreeze(found.map((row) => ({ id: row.id, name: row.name, parentId: row.parent_id })));
}

async function listTargets(
  tx: Tx,
  tenantId: string,
  scope: QualificationListScope,
  page: { limit: number; offset: number; typeId?: string },
) {
  pageOf(page);
  const predicate = scopePredicate(scope);
  const typeId = page.typeId === undefined ? undefined : normalizedUuid(page.typeId, '指标类型 ID');
  const found = rowsOf<{ id: string; code: string; name: string; type_id: string }>(
    await tx.execute(sql`SELECT t.id, t.code, t.name, t.type_id FROM ql_targets t
      WHERE t.tenant_id = ${normalizedUuid(tenantId, '租户 ID')}::uuid AND t.enabled AND (${predicate})
        ${typeId ? sql`AND t.type_id = ${typeId}::uuid` : sql``}
      ORDER BY t.display_order, t.code, t.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return deepFreeze(found.map((row) => ({ id: row.id, code: row.code, name: row.name, typeId: row.type_id })));
}

/** 端口的 tx 参数在领域层是 unknown（领域包不依赖数据库），这里收窄为租户事务。 */
const port: QualificationIndicatorPort = {
  indicators: (tx, tenantId, employeeId, asOf, filter) => indicators(tx as Tx, tenantId, employeeId, asOf, filter),
  listTargetTypes: (tx, tenantId, scope, page) => listTargetTypes(tx as Tx, tenantId, scope, page),
  listTargets: (tx, tenantId, scope, page) => listTargets(tx as Tx, tenantId, scope, page),
};

registerQualificationIndicatorPort(port);
