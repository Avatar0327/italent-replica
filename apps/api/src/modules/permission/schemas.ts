/** 权限接口的请求体校验。批量字段设上限（AGENTS.md §10「批量」）：原站任职记录 274 字段、349 按钮。 */
import { ADMIN_ROLES, BUTTON_LEVELS } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { grantScopeBody } from './data-scope-schemas.js';

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
});

export const grantBody = z.strictObject({
  userId: z.uuid(),
  profileId: z.uuid(),
  scopes: z.array(grantScopeBody).max(100).optional(),
});

export const adminSetsBody = z.strictObject({
  grantableAdminRoles: z.array(z.enum(ADMIN_ROLES)).max(ADMIN_ROLES.length),
  grantableProfileIds: z.array(z.uuid()).max(MAX_ITEMS),
});

export const adminBody = adminSetsBody.extend({ userId: z.uuid(), role: z.enum(ADMIN_ROLES) });

const optionalUuid = z.uuid().optional();
export const grantQuery = {
  parse(input: { userId: string | undefined }): { userId: string | undefined } {
    const parsed = optionalUuid.safeParse(input.userId);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'userId 必须是 UUID');
    return { userId: parsed.data };
  },
};
