/** F-035 / DEC-285②：表单字段与必填约束由服务端 schema 和当前权限共同确定。 */
import { withTenant, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import type { Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { editableModuleFields, resolveModuleScope } from '../permission/module-access.js';
import {
  codeOf,
  fieldVisible,
  isDictionary,
  requireCreatable,
  requireVisible,
  talentContext,
  talentWriteContext,
  TALENT_LABELS,
  UNIT_SELECTION,
  viewableFields,
  type Owner,
  type TalentObject,
} from './access.js';
import { uuidQuery } from './http.js';
import { authorizedUnits, NO_UNIT_MESSAGE } from './owner-units.js';

interface FormObject<View extends object> {
  readonly object: TalentObject;
  readonly createSchema: z.ZodType;
  readonly patchSchema: z.ZodType;
  owner(view: View): Owner;
  load(tx: Tx, tenantId: string, id: string): Promise<View | undefined>;
}

/** 派生自对应操作的严格对象 schema，建后不可改字段和系统选择项不会进入编辑集合。 */
function schemaFields(schema: z.ZodType) {
  if (!(schema instanceof z.ZodObject)) throw new Error('人才标准表单必须使用对象 schema');
  const entries = Object.entries(schema.shape as Record<string, z.ZodType>).filter(([key]) => !UNIT_SELECTION.has(key));
  return {
    fields: entries.map(([key]) => key),
    requiredFields: entries.filter(([, field]) => !field.isOptional()).map(([key]) => key),
  };
}

/** 单条动态路由的对象处理器；不会返回对象内容或未经裁剪的候选值。 */
export function talentFormHandler<View extends object>(deps: TenantRouteDeps, spec: FormObject<View>) {
  return async (c: Context<TenantEnv>) => {
    const operation = c.req.query('operation');
    if (operation !== 'create' && operation !== 'update') {
      throw new AppError('VALIDATION_FAILED', 'operation 必须为 create 或 update');
    }
    const id = uuidQuery(c, 'id');
    if (operation === 'update' && !id) throw new AppError('VALIDATION_FAILED', '编辑表单必须提供对象标识');
    const ctx = await talentWriteContext(c, deps, spec.object, operation, 0);
    await talentContext(c, deps, spec.object);
    // 契约沿用写入口的无页面范围；query id 不能使编辑表单落入列表页面的空范围策略。
    const scope = await resolveModuleScope(deps, ctx, undefined, codeOf(spec.object));
    const viewed = await viewableFields(deps, ctx, spec.object);
    const { fields, requiredFields } = schemaFields(operation === 'create' ? spec.createSchema : spec.patchSchema);
    const snapshot = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      if (operation === 'update') {
        const found = await spec.load(tx, ctx.tenantId, id!);
        if (!found) throw new AppError('NOT_FOUND', `${TALENT_LABELS[spec.object]}不存在`);
        requireVisible(scope, spec.object, spec.owner(found));
      }
      return {
        editable: await editableModuleFields(deps.authorize, tx, ctx, codeOf(spec.object)),
        units:
          operation === 'create' && !isDictionary(spec.object)
            ? await authorizedUnits(tx, ctx.tenantId, ctx.userId, tenantLocalDate(ctx.now, ctx.timezone))
            : [],
      };
    });
    const candidates = fields.filter((field) => fieldVisible(viewed, field));
    const accepted = await Promise.all(
      candidates.map(async (field) => {
        const allowed = snapshot.editable
          ? snapshot.editable.has(field)
          : await deps.authorize({
              ...ctx,
              action: `object.${operation}`,
              resource: codeOf(spec.object),
              fields: [field],
            });
        return allowed ? field : undefined;
      }),
    );
    const editableFields = accepted.filter((field): field is string => field !== undefined);
    const missingRequired = requiredFields.some((field) => !editableFields.includes(field));
    let blockedReason: string | undefined;
    if (missingRequired) blockedReason = '缺少必填字段的查看或编辑权限，无法新建，请联系管理员授权';
    else if (operation === 'create') {
      if (!isDictionary(spec.object) && !snapshot.units.length) blockedReason = NO_UNIT_MESSAGE;
      else {
        const units = isDictionary(spec.object) ? [undefined] : snapshot.units.map(({ id: unit }) => unit);
        const canCreate = units.some((unit) => {
          try {
            requireCreatable(scope, spec.object, unit);
            return true;
          } catch (error) {
            if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
            throw error;
          }
        });
        if (!canCreate) blockedReason = '无可用的新建数据范围，请联系管理员授权';
      }
    }
    return c.json({ editableFields, requiredFields, ...(blockedReason ? { blockedReason } : {}) });
  };
}
