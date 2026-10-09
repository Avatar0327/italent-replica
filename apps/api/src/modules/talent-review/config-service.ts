/**
 * 盘点分类与盘点角色的读写（设计 §2.2、§7 配置 CRUD 行）：通用骨架见 config-kit.ts；角色编码建后不可改（输入不收）。
 */
import { talentReviewCategories as C, talentReviewRoles as R } from '@italent/db';
import {
  type ConfigSpec,
  type ConfigTable,
  createConfig,
  deleteConfig,
  listConfig,
  loadConfig,
  updateConfig,
  type WriteContext,
} from './config-kit.js';
import type { CategoryCreate, CategoryPatch, RoleCreate, RolePatch } from './config-input.js';

const audited = (t: typeof C | typeof R) => ({
  id: t.id,
  name: t.name,
  sortNo: t.sortNo,
  enabled: t.enabled,
  revision: t.revision,
  createdBy: t.createdBy,
  createdAt: t.createdAt,
  updatedBy: t.updatedBy,
  updatedAt: t.updatedAt,
});

export type CategoryView = typeof C.$inferSelect;
export type RoleView = typeof R.$inferSelect;
type Named = { id: string; name: string };

export const CATEGORY: ConfigSpec<CategoryView & Named> = {
  object: 'category',
  label: '盘点分类',
  table: C as unknown as ConfigTable,
  view: audited(C),
  orderBy: [C.sortNo, C.name],
  duplicate: 'CATEGORY_DUPLICATE',
  inUse: 'CATEGORY_IN_USE',
};
export const ROLE: ConfigSpec<RoleView & Named> = {
  object: 'role',
  label: '盘点角色',
  table: R as unknown as ConfigTable,
  view: { ...audited(R), code: R.code, resolver: R.resolver },
  orderBy: [R.sortNo, R.code],
  duplicate: 'ROLE_DUPLICATE',
  inUse: 'ROLE_IN_USE',
};

export { listConfig, loadConfig };
export const createCategory = (tx: Parameters<typeof createConfig>[0], ctx: WriteContext, input: CategoryCreate) =>
  createConfig(tx, CATEGORY, ctx, input);
export const updateCategory = (
  tx: Parameters<typeof createConfig>[0],
  ctx: WriteContext,
  id: string,
  p: CategoryPatch,
) => updateConfig(tx, CATEGORY, ctx, id, p);
export const deleteCategory = (tx: Parameters<typeof createConfig>[0], ctx: WriteContext, id: string) =>
  deleteConfig(tx, CATEGORY, ctx, id);
export const createRole = (tx: Parameters<typeof createConfig>[0], ctx: WriteContext, input: RoleCreate) =>
  createConfig(tx, ROLE, ctx, input);
export const updateRole = (tx: Parameters<typeof createConfig>[0], ctx: WriteContext, id: string, p: RolePatch) =>
  updateConfig(tx, ROLE, ctx, id, p);
export const deleteRole = (tx: Parameters<typeof createConfig>[0], ctx: WriteContext, id: string) =>
  deleteConfig(tx, ROLE, ctx, id);
