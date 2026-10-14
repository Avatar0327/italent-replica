/**
 * ESS 本人入口：个人主页“员工通道”卡片（C1-6，AC-QL-08；规格 23 §19，DEC-399②，DEC-402①；设计 §5.2 #2、§5.3）。
 * 关系入口：不要求 Qualification 数据范围，也不要求 DevelopmentChannel / QualificationStandard 的对象权限；要求员工发展通道
 * 页面权限（employeePageGranted），无权 403 PAGE_PERMISSION_REQUIRED。卡片数据由后端按本人直接读取（🟡 推断）。
 * 返回固定投影：键集合固定、不随对象字段权限变化；**不含各级标准明细 / 级别描述**（23 §19 员工端没有看到，拆分方案 C1-6）；
 * 没有当前资格是空态（current: null，纵向 / 横向为空数组）。名称取自类别 / 级别配置，横向只给目的地的类别与级别名称。
 */
import { sql, type Tx } from '@italent/db';
import { QUALIFICATION_APP, type EmployeePage } from '@italent/domain';
import { AppError } from '../../errors.js';
import { rowsOf } from '../employment/record-store.js';
import { channelOverview } from '../qualification/development-channel-data.js';
import { employeePageGranted } from './page-permission.js';
import type { SelfAccess } from './access.js';

const PAGE: EmployeePage = 'EmployeeDevelopmentChannel';

async function names(tx: Tx, tenantId: string, table: 'ql_categories' | 'ql_levels', ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = rowsOf<{ id: string; name: string }>(
    await tx.execute(sql`SELECT id, name FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid
      AND id = ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[])`),
  );
  return new Map(rows.map((row) => [row.id, row.name]));
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
  if (!current) return { asOf, current: null, vertical: [], horizontal: [] };
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
  };
}
