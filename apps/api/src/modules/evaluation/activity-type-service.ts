/**
 * 活动类型（`TEvaluation.ActivityType`，字典）的写入服务（设计 §3.2、§5.1）：看全部 ∪ 创建人，新建只认看全部
 * （DEC-121 / DEC-082 / DEC-356②）；无“同步任职记录”（DEC-025）。每个写入口在命令台账的同一事务里写业务与审计。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { EVALUATION_LABELS } from './access.js';
import type * as input from './input.js';
import { type ActivityTypeView, reload } from './read-model.js';
import { audit, bumped, guardUnique, lockEditable, rowsOf, type WriteContext } from './store.js';
import { rejectInUse } from './usage.js';

/**
 * 原站提示原文（Q-M0-152，W-755）；名称在租户内精确比较（输入已 trim，大小写区分，同其他字典）。
 * 名称唯一是租户级约束，创建人范围的人改名撞上范围外的类型也得到这条提示，借此能探测范围外类型名称是否存在：
 * 照原站的已知行为，不另加防护（DEC-373③）。
 */
const nameExists = () =>
  new AppError('CONFLICT', '活动类型名称已存在，请重新输入', { reason: 'ACTIVITY_TYPE_NAME_EXISTS' });

export async function createActivityType(tx: Tx, ctx: WriteContext, body: input.ActivityTypeCreate) {
  // 新建只认看全部：创建人维度的人不能新建（与不存在同一个 404）
  if (!ctx.scope.all) throw new AppError('NOT_FOUND', `${EVALUATION_LABELS.activityType}不存在`);
  const now = ctx.now.toISOString();
  const result = await guardUnique(
    () =>
      tx.execute(sql`INSERT INTO ev_activity_types
        (tenant_id, name, display_order, enabled, sync_qualification, created_by, created_at, updated_at)
      VALUES (${ctx.tenantId}, ${body.name}, ${body.displayOrder ?? 0}, ${body.enabled ?? true},
        ${body.syncQualification ?? false}, ${ctx.userId}, ${now}, ${now}) RETURNING id`),
    nameExists,
  );
  const id = rowsOf<{ id: string }>(result)[0]!.id;
  const after = await reload<ActivityTypeView>(tx, ctx.tenantId, 'activityType', id);
  await audit(tx, ctx, 'activityType', 'create', id, { before: null, after });
  return after;
}

const COLUMNS = {
  name: 'name',
  displayOrder: 'display_order',
  enabled: 'enabled',
  syncQualification: 'sync_qualification',
} as const;

export async function updateActivityType(tx: Tx, ctx: WriteContext, id: string, body: input.ActivityTypePatch) {
  const row = await lockEditable(tx, ctx, 'activityType', id);
  // 被活动引用的类型不能停用（原站“停用”置灰）；只拦 启用 → 停用，B5 登记引用方
  if (body.enabled === false && row.enabled === true) await rejectInUse(tx, ctx, 'activityType', id, 'disable');
  const before = await reload<ActivityTypeView>(tx, ctx.tenantId, 'activityType', id);
  const bump = bumped(ctx);
  const sets = (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[])
    .filter((field) => body[field] !== undefined)
    .map((field) => sql`${sql.identifier(COLUMNS[field])} = ${body[field] as never}`);
  sets.push(sql`revision = ${bump.revision}`, sql`updated_at = ${bump.updatedAt}`);
  await guardUnique(
    () =>
      tx.execute(sql`UPDATE ev_activity_types SET ${sql.join(sets, sql`, `)}
        WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`),
    nameExists,
  );
  const after = await reload<ActivityTypeView>(tx, ctx.tenantId, 'activityType', id);
  await audit(tx, ctx, 'activityType', 'update', id, { before, after });
  return after;
}

export async function deleteActivityType(tx: Tx, ctx: WriteContext, id: string) {
  await lockEditable(tx, ctx, 'activityType', id);
  // B5 登记“被评定活动引用”（usage.ts 钩子位，delete 阶段）
  await rejectInUse(tx, ctx, 'activityType', id);
  const before = await reload<ActivityTypeView>(tx, ctx.tenantId, 'activityType', id);
  await tx.execute(sql`DELETE FROM ev_activity_types WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ${id}::uuid`);
  await audit(tx, ctx, 'activityType', 'delete', id, { before, after: null });
  return before;
}
