/**
 * ESS 本人入口：个人主页“员工通道”卡片（C1-6，AC-QL-08；规格 23 §19，DEC-399②，DEC-402①；设计 §5.2 #2、§5.3）。
 * 关系入口：不要求 Qualification 数据范围，也不要求 DevelopmentChannel / QualificationStandard 的对象权限；要求员工发展通道
 * 页面权限（employeePageGranted），无权 403 PAGE_PERMISSION_REQUIRED。卡片数据由后端按本人直接读取（🟡 推断）。
 * 返回固定投影：键集合固定、不随对象字段权限变化；含“当前任职资格对应的各级标准”（standard：本人当前类别那条标准的各级别描述、
 * 指标目标值 / 权重、能力标准，DEC-778①，取代原“不含各级标准明细”）——只含本人当前类别，横向目的地类别的标准不给，
 * 不暴露来源 / 锁定 / 修订号 / 负责人等配置内部字段，也不扩大读取范围；
 * 没有当前资格或当前类别没有标准时 standard 为 null（空态：current: null，纵向 / 横向为空数组）。
 * 名称取自类别 / 级别配置，横向只给目的地的类别与级别名称。
 */
import { sql, type Tx } from '@italent/db';
import { QUALIFICATION_APP, type EmployeePage } from '@italent/domain';
import { AppError } from '../../errors.js';
import { rowsOf } from '../employment/record-store.js';
import { channelOverview } from '../qualification/development-channel-data.js';
import { loadRow, withStandardParts } from '../qualification/read-model.js';
import { employeePageGranted } from './page-permission.js';
import type { SelfAccess } from './access.js';

const PAGE: EmployeePage = 'EmployeeDevelopmentChannel';

async function names(
  tx: Tx,
  tenantId: string,
  table: 'ql_categories' | 'ql_levels' | 'ql_targets',
  ids: readonly string[],
) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(sql`SELECT id, name FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid
      AND id = ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** 各级标准卡（DEC-778①）：固定字段，按纵向级别顺序；没有配置的级别给空指标与空描述。 */
async function standardCard(
  tx: Tx,
  tenantId: string,
  standardId: string,
  vertical: readonly { levelId: string; displayOrder: number }[],
  levels: ReadonlyMap<string, string>,
  currentLevelId: string,
) {
  const row = (await loadRow(tx, tenantId, 'standard', standardId))!;
  const { name, details, levelDescriptions } = (await withStandardParts(tx, tenantId, [row]))[0]!;
  const targetNames = await names(tx, tenantId, 'ql_targets', [...new Set(details.map((d) => d.targetId))]);
  return {
    standardId,
    name,
    levels: vertical.map((node) => ({
      levelId: node.levelId,
      levelName: levels.get(node.levelId) ?? '',
      displayOrder: node.displayOrder,
      isCurrent: node.levelId === currentLevelId,
      description: levelDescriptions.find((d) => d.levelId === node.levelId)?.description ?? null,
      targets: details
        .filter((d) => d.levelId === node.levelId)
        .map((d) => ({
          targetId: d.targetId,
          targetName: targetNames.get(d.targetId) ?? '',
          targetValue: d.targetValue,
          weight: d.weight,
          abilities: d.abilities.map((a) => ({ content: a.content, targetValue: a.targetValue, weight: a.weight })),
        })),
    })),
  };
}

export async function ownDevelopmentChannel(tx: Tx, self: SelfAccess, asOf: string) {
  const { tenantId, userId } = self.ctx;
  if (!(await employeePageGranted(tx, { tenantId, userId }, PAGE, self.ctx.authorize))) {
    throw new AppError('FORBIDDEN', '无权查看员工发展通道', {
      reason: 'PAGE_PERMISSION_REQUIRED',
      app: QUALIFICATION_APP,
      page: PAGE,
    });
  }
  const { current, channel } = await channelOverview(tx, tenantId, self.employee.id, asOf);
  if (!current) return { asOf, current: null, vertical: [], horizontal: [], standard: null };
  const vertical = channel?.vertical ?? [];
  const horizontal = channel?.horizontal ?? [];
  const levels = await names(tx, tenantId, 'ql_levels', [
    current.levelId,
    ...vertical.map((n) => n.levelId),
    ...horizontal.map((h) => h.targetLevelId),
  ]);
  const categories = await names(tx, tenantId, 'ql_categories', [
    current.categoryId,
    ...horizontal.map((h) => h.targetCategoryId),
  ]);
  return {
    asOf,
    current: {
      categoryId: current.categoryId,
      categoryName: categories.get(current.categoryId) ?? '',
      levelId: current.levelId,
      levelName: levels.get(current.levelId) ?? '',
      startDate: current.startDate,
    },
    vertical: vertical.map((node) => ({
      levelId: node.levelId,
      levelName: levels.get(node.levelId) ?? '',
      displayOrder: node.displayOrder,
      isCurrent: node.levelId === current.levelId,
    })),
    horizontal: horizontal.map((h) => ({
      fromLevelId: h.levelId,
      targetCategoryId: h.targetCategoryId,
      targetCategoryName: categories.get(h.targetCategoryId) ?? '',
      targetLevelId: h.targetLevelId,
      targetLevelName: levels.get(h.targetLevelId) ?? '',
    })),
    standard: channel ? await standardCard(tx, tenantId, channel.standardId, vertical, levels, current.levelId) : null,
  };
}
