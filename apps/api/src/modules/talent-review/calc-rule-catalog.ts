/**
 * 计算规则读写共用的字段目录：租户的全部盘点字段（不按查看人过滤，只用于计算不暴露名称的提示、冻结与分析），
 * 以及按查看人（字段目录对象范围 + name / kind / enabled / systemWritten 四列查看权）过滤出的可引用字段。
 */
import { and, asc, eq, inArray, talentReviewFields as F, type Tx } from '@italent/db';
import type { FormulaField } from '@italent/domain';
import { requireConfigVisible, type ModuleScope } from './access.js';

/** 公式 / 目标字段解析所需的字段目录访问：对象范围 + 查看人对 name / kind / enabled / systemWritten 四列的查看权。 */
export interface CatalogAccess {
  readonly scope: ModuleScope;
  /** 四列都可见才可引用；缺任一列时每个字段都与“不存在”不可区分（不暴露名称、类型、停用与系统写入属性）。 */
  readonly columns: boolean;
}

export type CatalogRow = FormulaField & { readonly createdBy: string | null };

/** 租户的全部盘点字段（不按查看人过滤）。 */
export async function loadFullCatalog(tx: Tx, tenantId: string): Promise<CatalogRow[]> {
  const rows = await tx
    .select({
      id: F.id,
      name: F.name,
      kind: F.kind,
      enabled: F.enabled,
      systemWritten: F.systemWritten,
      createdBy: F.createdBy,
    })
    .from(F)
    .where(eq(F.tenantId, tenantId));
  return rows.map((r) => ({ ...r, kind: r.kind as FormulaField['kind'] }));
}

/** 查看人能引用的字段：没有字段目录访问、缺四列任一列查看权时为空；否则按字段目录范围过滤。 */
export function visibleOf(rows: readonly CatalogRow[], access: CatalogAccess | undefined): FormulaField[] {
  if (!access?.columns) return [];
  const visible = (createdBy: string | null) => {
    try {
      requireConfigVisible(access.scope, 'field', createdBy);
      return true;
    } catch {
      return false;
    }
  };
  return rows.filter((r) => visible(r.createdBy)).map(({ createdBy: _createdBy, ...r }) => r);
}

/** 当前操作人可引用的盘点字段：字段目录对象范围内可见，且四个相关列都有查看权。 */
export async function loadVisibleCatalog(
  tx: Tx,
  tenantId: string,
  access: CatalogAccess | undefined,
): Promise<FormulaField[]> {
  if (!access) throw new Error('计算项目缺少字段目录访问');
  return visibleOf(await loadFullCatalog(tx, tenantId), access);
}

/** 被引用字段行的共享锁，按字段 id 排序（与字段变更入口的行锁同序）。 */
export async function lockFields(tx: Tx, tenantId: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  await tx
    .select({ id: F.id })
    .from(F)
    .where(and(eq(F.tenantId, tenantId), inArray(F.id, [...ids])))
    .orderBy(asc(F.id))
    .for('share');
}
