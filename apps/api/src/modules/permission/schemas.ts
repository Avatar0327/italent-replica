/** 权限接口的请求体校验。批量字段设上限（AGENTS.md §10「批量」）：原站任职记录 274 字段、349 按钮。 */
import { ADMIN_ROLES, BUTTON_LEVELS } from '@italent/domain';
import { z } from 'zod';
import { grantScopeBody } from './data-scope-schemas.js';
import { listPage, textFilter } from './enterprise-lists.js';

const MAX_ITEMS = 1000;
const code = (pattern: RegExp) => z.string().regex(pattern);
const PROFILE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const APP_CODE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const LICENSE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ITEM_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;

export const profileBody = z.strictObject({
  code: code(PROFILE_CODE),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(''),
  apps: z.array(code(APP_CODE)).max(100),
  licenseType: code(LICENSE_TYPE).nullable().default(null),
});

export const objectPermissionBody = z.strictObject({
  dataOperations: z.strictObject({ create: z.boolean(), update: z.boolean(), delete: z.boolean() }),
  fields: z.array(z.strictObject({ fieldCode: code(ITEM_CODE), view: z.boolean(), edit: z.boolean() })).max(MAX_ITEMS),
  buttons: z.array(z.strictObject({ buttonCode: code(ITEM_CODE), level: z.enum(BUTTON_LEVELS) })).max(MAX_ITEMS),
  // F-061 D2 = A：GET 详情里该对象的 catalogDigest（16 位十六进制）；可选，旧客户端不带
  catalogDigest: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});

export const grantBody = z.strictObject({
  userId: z.uuid(),
  profileId: z.uuid(),
  scopes: z.array(grantScopeBody).max(100).optional(),
});

export const adminSetsBody = z.strictObject({
  contractConfiguration: z.boolean().optional(),
  grantableAdminRoles: z.array(z.enum(ADMIN_ROLES)).max(ADMIN_ROLES.length),
  grantableProfileIds: z.array(z.uuid()).max(MAX_ITEMS),
});

export const adminBody = adminSetsBody.extend({ userId: z.uuid(), role: z.enum(ADMIN_ROLES) });

/** 用户授权列表（F-474-5 #22）：筛选 + 分页；userId 保持原有的按用户查询。 */
export const grantListQuery = z.strictObject({
  userId: z.uuid().optional(),
  profileId: z.uuid().optional(),
  mouId: z.uuid().optional(),
  status: z.enum(['active', 'revoked']).optional(),
  q: textFilter.optional(),
  ...listPage,
});

/** 管理员列表（F-474-5 #23）。 */
export const adminListQuery = z.strictObject({
  role: z.enum(ADMIN_ROLES).optional(),
  mouId: z.uuid().optional(),
  q: textFilter.optional(),
  ...listPage,
});

/** 身份列表（F-474-5 #25）：名称 / 编码包含匹配，关联应用精确匹配；默认一页取全以兼容既有调用方。 */
export const profileListQuery = z.strictObject({
  name: textFilter.optional(),
  code: textFilter.optional(),
  app: z.string().regex(APP_CODE).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
  offset: listPage.offset,
});

/** 数据操作权限弹窗：只有三个开关，不带字段与按钮（沿用整对象写入口保存，见 object-dialogs.ts）。 */
export const dataOperationsBody = z.strictObject({
  dataOperations: z.strictObject({ create: z.boolean(), update: z.boolean(), delete: z.boolean() }),
});

/** 字段权限弹窗：只提交被改动的字段，服务端合并进现有对象权限；目录指纹含义同整对象保存。 */
export const fieldsBody = z.strictObject({
  fields: z
    .array(z.strictObject({ fieldCode: code(ITEM_CODE), view: z.boolean(), edit: z.boolean() }))
    .min(1)
    .max(MAX_ITEMS),
  catalogDigest: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
});

/** 字段权限弹窗列表：按字段编码包含筛选（目录无字段显示名）；原站 100 条 / 页。 */
export const fieldsQuery = z.strictObject({
  code: textFilter.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: listPage.offset,
});
